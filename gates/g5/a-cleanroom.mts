// Gate G5.a [live] — clean-room install. `npm pack` → install the tarball
// in a fresh node:20 container → `kami-lens daemon` with ZERO config
// reaches LIVE → a sample query returns schema-valid JSON. Every step
// exit-code-checked. The container has only the tarball — whatever the
// package forgot to ship fails here.
//
// 0.6.3: it now also asserts that dist/checkpoint-child.js IS in the
// installed package. The periodic checkpoint forks that file (divergence
// 16), and a package that forgot it would install, reach LIVE and answer
// every query here exactly as it does now — then fail its first checkpoint
// ten minutes later, in production, with nothing in this gate having
// noticed. THE FORK ITSELF is proven in G5.b, which has a volume and can
// therefore let a checkpoint actually run; this leg keeps its zero-config
// contract and only asserts the file shipped.

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import Ajv from 'ajv/dist/2020';

import { loadSchema } from '../../src/queries/registry';
import { ARTIFACTS_DIR, fail, pass, REPO_ROOT, sleep, writeMeasurement } from '../g1/lib.mts';

const CONTAINER = 'kami-lens-g5a';
const DAEMON_LOG = '/daemon.log';
const run = (cmd: string, args: string[], timeoutMs = 120_000): string =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, cwd: REPO_ROOT });
const runQuiet = (cmd: string, args: string[], timeoutMs = 120_000): string => {
  try {
    return run(cmd, args, timeoutMs);
  } catch {
    return '';
  }
};

/** node:20-slim has neither `ps` nor `pgrep`, so liveness is read from
 * /proc: any process whose comm is `node`. */
const containerHasNode = (): boolean =>
  runQuiet('docker', [
    'exec', CONTAINER, 'sh', '-c',
    'for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = node ] && echo yes && break; done',
  ]).includes('yes');

const daemonLog = (): string => runQuiet('docker', ['exec', CONTAINER, 'cat', DAEMON_LOG], 60_000);

/** One health poll, with BOTH facts: the state it printed and the exit
 * code it left. `kami-lens health` prints the state on stdout and exits 0
 * only when it is LIVE (src/cli.ts). */
const healthProbe = (): { state: string; rc: number } => {
  try {
    const out = run('docker', ['exec', CONTAINER, 'kami-lens', 'health'], 20_000);
    return { state: lastWord(out), rc: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; message?: string };
    return { state: lastWord(err.stdout ?? ''), rc: err.status ?? -1 };
  }
};

/** the state is the last non-empty line — the logger writes a banner first */
const lastWord = (out: string): string =>
  out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';

/** What old-space cap Node picked for ITSELF in this container — the
 * number the OOM diagnosis turns on. */
const nodeHeapLimitMiB = (): number =>
  Number(
    runQuiet('docker', [
      'exec', CONTAINER, 'node', '-p',
      'Math.round(require("v8").getHeapStatistics().heap_size_limit/1048576)',
    ]).trim()
  ) || -1;

// docker present?
try {
  run('docker', ['info'], 30_000);
} catch {
  fail('G5.a', { reason: 'docker unavailable — start colima (--memory 8) first' });
}

// fresh tarball
const packOut = run('npm', ['pack', '--json'], 300_000);
const tarball = (JSON.parse(packOut) as { filename: string }[])[0].filename;
console.log(`packed ${tarball}`);

const steps: Record<string, boolean> = {};
try {
  run('docker', ['rm', '-f', CONTAINER]);
} catch {
  /* no leftover container */
}

let coldSeconds = -1;
let savedLog = '';
let diagnosis: string | undefined;
let secondsToExit: number | undefined;
const polls: { atSeconds: number; state: string; rc: number }[] = [];
let queryError: string | undefined;
let daemonAliveAtQuery: boolean | undefined;
let heapLimitMiB = -1;
try {
  // container with ONLY node:20 + the tarball (docker cp, not a bind
  // mount — colima's shared-folder mounts go stale across re-packs)
  run('docker', ['run', '-d', '--name', CONTAINER, 'node:20-slim', 'sleep', 'infinity']);
  steps.containerUp = true;
  run('docker', ['cp', path.join(REPO_ROOT, tarball), `${CONTAINER}:/pkg.tgz`]);

  run('docker', ['exec', CONTAINER, 'npm', 'install', '-g', '/pkg.tgz'], 300_000);
  steps.install = true;

  // recorded on every run, pass or fail: it is the number this leg's one
  // real failure turned on, and it is worthless discovered afterwards
  heapLimitMiB = nodeHeapLimitMiB();
  console.log(`node picked a ${heapLimitMiB} MiB old-space cap in this container`);

  const version = run('docker', ['exec', CONTAINER, 'kami-lens', '--version']);
  steps.version = version.includes('kami-lens') && /[0-9a-f]{40}/.test(version);
  console.log(version.trim());

  // zero-config daemon (baked Yominet defaults), detached. Its output goes
  // to a file so a failure can be READ rather than inferred — see the
  // diagnosis in the wait loop below.
  run('docker', ['exec', '-d', CONTAINER, 'sh', '-c', `kami-lens daemon > ${DAEMON_LOG} 2>&1`]);
  steps.daemonStarted = true;

  const t0 = Date.now();
  let live = false;
  for (let i = 0; i < 100; i++) {
    await sleep(5000);
    // READ THE STATE, DO NOT INFER IT FROM AN EXIT CODE. `kami-lens
    // health` PRINTS the state and exits 0 only on LIVE, and this loop
    // used to check the exit code alone — then recorded `live: true` for a
    // run whose daemon never left BACKFILL and died at 61 %, which is a
    // gate asserting the opposite of what happened. Both are read now, the
    // state must actually say LIVE, and every poll is recorded so the next
    // surprise is a line in the measurement rather than an argument.
    const probe = healthProbe();
    polls.push({ atSeconds: Math.round((Date.now() - t0) / 1000), ...probe });
    if (probe.state === 'LIVE' && probe.rc === 0) {
      live = true;
      break;
    }
    // DIAGNOSE, DO NOT JUST TIME OUT (0.6.3). This leg spent 500 s
    // reporting "did not reach LIVE" for a daemon that had been dead for
    // 480 of them, with the reason sitting in its own log. A dead process
    // is a verdict, not a reason to keep waiting.
    if (!containerHasNode()) {
      // BREAK, DO NOT fail() HERE. A fail() at this point exits before the
      // measurement is written, so the run left the PREVIOUS run's file
      // sitting on disk under today's date — and a stale record read as
      // this run's is worse than no record at all (it cost an hour of
      // reading `live: true` from a run that had never gone live). Every
      // exit from this leg now goes through the one writer below.
      diagnosis = 'the daemon process exited before reaching LIVE';
      secondsToExit = Math.round((Date.now() - t0) / 1000);
      break;
    }
  }
  coldSeconds = Math.round((Date.now() - t0) / 1000);
  steps.live = live;
  if (!live) {
    diagnosis ??= 'daemon did not reach LIVE in the container within 500 s';
  }

  // divergence 16: the child entry must have SHIPPED. `ls` and not a
  // checkpoint: this daemon runs with zero config, so its checkpoint
  // interval is the ten-minute default and waiting for one here would buy
  // in ten minutes what G5.b buys in one.
  const childPath = '/usr/local/lib/node_modules/kami-lens/dist/checkpoint-child.js';
  try {
    run('docker', ['exec', CONTAINER, 'test', '-s', childPath]);
    steps.checkpointChildShipped = true;
  } catch {
    steps.checkpointChildShipped = false;
  }

  // sample query → schema-valid envelope with data.
  //
  // GUARDED, because an unguarded `run` here threw a raw execFileSync
  // stack trace out of the gate: the daemon had gone healthy and then
  // died, `items` answered NO_DAEMON with exit 4, and the gate reported a
  // node internal error instead of "the daemon died after LIVE" — and
  // then removed the container holding the reason.
  try {
    if (!live) throw new Error('skipped: the daemon never reached LIVE');
    const itemsOut = run('docker', ['exec', CONTAINER, 'kami-lens', 'items'], 60_000);
    const response = JSON.parse(itemsOut) as { ok: boolean; data: { items: unknown[] } };
    steps.queryOk = response.ok === true;
    const ajv = new Ajv({ strict: true, allErrors: true });
    steps.querySchemaValid = ajv.validate(loadSchema('items'), response.data) as boolean;
    steps.queryNonEmpty = response.data.items.length > 100;
  } catch (e) {
    steps.queryOk = false;
    queryError = e instanceof Error ? e.message : String(e);
    daemonAliveAtQuery = containerHasNode();
  }
} finally {
  // THE EVIDENCE OUTLIVES THE CONTAINER. Every failure of this leg so far
  // has been diagnosed from a log that the teardown had already deleted,
  // which is how a 20-second OOM became a 500-second mystery twice.
  savedLog = daemonLog();
  try {
    await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
    await fs.writeFile(path.join(ARTIFACTS_DIR, 'g5a-daemon.log'), savedLog);
  } catch {
    /* the tail still reaches the measurement below */
  }
  try {
    run('docker', ['rm', '-f', CONTAINER]);
  } catch {
    /* already gone */
  }
}

const oom = /Ineffective mark-compacts near heap limit|heap out of memory/.test(savedLog);
if (oom && diagnosis) diagnosis = 'the zero-config daemon ran out of JS heap during the cold load';
await writeMeasurement('g5a-cleanroom', {
  tarball,
  ...(diagnosis ? { diagnosis, secondsToExit } : {}),
  steps,
  timeToLiveSeconds: coldSeconds,
  nodeHeapLimitMiB: heapLimitMiB,
  oomInDaemonLog: oom,
  healthPolls: polls,
  ...(queryError ? { queryError, daemonAliveAtQuery } : {}),
  daemonLogTail: savedLog.split('\n').slice(-30),
  daemonLogSaved: path.join(ARTIFACTS_DIR, 'g5a-daemon.log'),
  match: Object.values(steps).every(Boolean),
});
if (!Object.values(steps).every(Boolean)) {
  fail('G5.a', {
    ...(diagnosis ? { reason: diagnosis, secondsToExit } : {}),
    steps,
    nodeHeapLimitMiB: heapLimitMiB,
    oomInDaemonLog: oom,
    ...(oom
      ? {
          note:
            'a cold boot builds the whole ECS image in memory (peak RSS 4.19-4.39 GB measured, ' +
            'g10a/g10c 0.6.2) and Node picked a smaller old-space default for itself. Remedy: ' +
            'NODE_OPTIONS=--max-old-space-size=6144 (the Dockerfile sets it; the bare tarball ' +
            'cannot).',
        }
      : {}),
    ...(queryError ? { queryError, daemonAliveAtQuery } : {}),
    daemonLogTail: savedLog.split('\n').slice(-30),
  });
}
pass('G5.a', { tarball, timeToLiveSeconds: coldSeconds, ...steps });
process.exit(0);
