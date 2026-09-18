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
import path from 'node:path';

import Ajv from 'ajv/dist/2020';

import { loadSchema } from '../../src/queries/registry';
import { fail, pass, REPO_ROOT, sleep, writeMeasurement } from '../g1/lib.mts';

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
try {
  // container with ONLY node:20 + the tarball (docker cp, not a bind
  // mount — colima's shared-folder mounts go stale across re-packs)
  run('docker', ['run', '-d', '--name', CONTAINER, 'node:20-slim', 'sleep', 'infinity']);
  steps.containerUp = true;
  run('docker', ['cp', path.join(REPO_ROOT, tarball), `${CONTAINER}:/pkg.tgz`]);

  run('docker', ['exec', CONTAINER, 'npm', 'install', '-g', '/pkg.tgz'], 300_000);
  steps.install = true;

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
    try {
      run('docker', ['exec', CONTAINER, 'kami-lens', 'health'], 20_000);
      live = true;
      break;
    } catch {
      /* not LIVE yet */
    }
    // DIAGNOSE, DO NOT JUST TIME OUT (0.6.3). This leg spent 500 s
    // reporting "did not reach LIVE" for a daemon that had been dead for
    // 480 of them, with the reason sitting in its own log. A dead process
    // is a verdict, not a reason to keep waiting.
    if (!containerHasNode()) {
      const log = daemonLog();
      const oom = /Ineffective mark-compacts near heap limit|heap out of memory/.test(log);
      fail('G5.a', {
        reason: oom
          ? 'the zero-config daemon ran out of JS heap during the cold load'
          : 'the daemon process exited before reaching LIVE',
        heapLimitMiB: nodeHeapLimitMiB(),
        note: oom
          ? 'a cold boot builds the whole ECS image in memory (peak RSS 4.19-4.39 GB measured, ' +
            'g10a/g10c 0.6.2). Node picks its old-space default from the machine it finds, and in ' +
            'a container that default is far below this. Remedy: NODE_OPTIONS=--max-old-space-size=6144.'
          : undefined,
        secondsToExit: Math.round((Date.now() - t0) / 1000),
        logTail: log.split('\n').slice(-25),
        steps,
      });
    }
  }
  coldSeconds = Math.round((Date.now() - t0) / 1000);
  steps.live = live;
  if (!live) fail('G5.a', { reason: 'daemon did not reach LIVE in the container within 500 s', steps });

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

  // sample query → schema-valid envelope with data
  const itemsOut = run('docker', ['exec', CONTAINER, 'kami-lens', 'items'], 60_000);
  const response = JSON.parse(itemsOut) as { ok: boolean; data: { items: unknown[] } };
  steps.queryOk = response.ok === true;
  const ajv = new Ajv({ strict: true, allErrors: true });
  steps.querySchemaValid = ajv.validate(loadSchema('items'), response.data) as boolean;
  steps.queryNonEmpty = response.data.items.length > 100;
} finally {
  try {
    run('docker', ['rm', '-f', CONTAINER]);
  } catch {
    /* already gone */
  }
}

await writeMeasurement('g5a-cleanroom', {
  tarball,
  steps,
  timeToLiveSeconds: coldSeconds,
  match: Object.values(steps).every(Boolean),
});
if (!Object.values(steps).every(Boolean)) fail('G5.a', { steps });
pass('G5.a', { tarball, timeToLiveSeconds: coldSeconds, ...steps });
process.exit(0);
