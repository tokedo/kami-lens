// Gate G5.a [live] — clean-room install, in TWO legs.
//
// `npm pack` → install the tarball in a container that has nothing else →
// `kami-lens daemon` with ZERO CONFIG → what happens must be right. The
// container has only the tarball, so whatever the package forgot to ship
// fails here.
//
//   PRIMARY, node:22-slim — zero config must reach LIVE and answer a
//   schema-valid query. Since 0.6.3 that requires the daemon to SELF-SIZE
//   its heap: Node's own old-space default in a container is 2,096 MiB
//   (measured) against a cold-boot peak of 4.2-4.4 GB, so the daemon
//   re-execs itself in place with --max-old-space-size (§3.1, src/heap.ts)
//   and `status.heap.source` must read 'self-configured'. This is the boot
//   DESIGN §5 promises and the launch-prompt test performs.
//
//   LEGACY, node:20-slim — the REFUSAL is the contract. process.execve
//   arrived in Node 22.15, so on older Node the daemon cannot raise its own
//   cap; it must refuse LOUDLY and FAST (under 5 s) with the exact remedy
//   line, and exit non-zero. What it used to do here was die of OOM 20 s
//   in, at 71.9 % of the values apply — the defect this release fixes.
//
// It also asserts dist/checkpoint-child.js is IN the installed package. The
// periodic checkpoint forks that file (divergence 16), and a package that
// forgot it would install, reach LIVE and answer every query exactly as it
// does now, then fail its first checkpoint ten minutes later in production.
// THE FORK ITSELF is proven in G5.b, which has a volume and can let a
// checkpoint actually run.
//
// EVIDENCE OUTLIVES THE CONTAINER. Every failure of this leg has been
// diagnosed from a log the teardown had already deleted, which is how a
// 20-second OOM became a 500-second mystery twice. The daemon log is copied
// to gates/.artifacts/ before teardown, and every health poll — the state
// it PRINTED and the exit code it left, not one inferred from the other —
// rides in the measurement.

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import Ajv from 'ajv/dist/2020';

import { loadSchema } from '../../src/queries/registry';
import { ARTIFACTS_DIR, fail, pass, REPO_ROOT, sleep, writeMeasurement } from '../g1/lib.mts';
import { COLD_BOOT_HEAP_FLOOR_MB, DAEMON_HEAP_TARGET_MB } from '../../src/heap';

const PRIMARY_IMAGE = 'node:22-slim';
const LEGACY_IMAGE = 'node:20-slim';
const DAEMON_LOG = '/daemon.log';
/** the refusal must be immediate — it is the whole difference between
 * "this box cannot run me" and a crash three minutes into a load */
const REFUSAL_BUDGET_MS = 5_000;
const LIVE_BUDGET_MS = 500_000;

const run = (cmd: string, args: string[], timeoutMs = 120_000): string =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, cwd: REPO_ROOT });
const runQuiet = (cmd: string, args: string[], timeoutMs = 120_000): string => {
  try {
    return run(cmd, args, timeoutMs);
  } catch {
    return '';
  }
};

try {
  run('docker', ['info'], 30_000);
} catch {
  fail('G5.a', { reason: 'docker unavailable — start colima (--memory 8) first' });
}

// fresh tarball
const packOut = run('npm', ['pack', '--json'], 300_000);
const tarball = (JSON.parse(packOut) as { filename: string }[])[0].filename;
console.log(`packed ${tarball}`);

/** the state is the last non-empty line — the logger writes a banner first */
const lastLine = (out: string): string =>
  out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';

type Leg = {
  image: string;
  container: string;
  /** every node process except none — node:*-slim has neither ps nor
   * pgrep, so liveness comes from /proc */
  hasNode: () => boolean;
  log: () => string;
  heapLimitMb: () => number;
};

function leg(image: string, container: string): Leg {
  return {
    image,
    container,
    hasNode: () =>
      runQuiet('docker', [
        'exec', container, 'sh', '-c',
        'for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = node ] && echo yes && break; done',
      ]).includes('yes'),
    log: () => runQuiet('docker', ['exec', container, 'cat', DAEMON_LOG], 60_000),
    heapLimitMb: () =>
      Number(
        runQuiet('docker', [
          'exec', container, 'node', '-p',
          'Math.round(require("v8").getHeapStatistics().heap_size_limit/1048576)',
        ]).trim()
      ) || -1,
  };
}

/** install the tarball into a fresh container of `image` */
async function install(l: Leg): Promise<{ version: string; childShipped: boolean }> {
  runQuiet('docker', ['rm', '-f', l.container]);
  run('docker', ['run', '-d', '--name', l.container, l.image, 'sleep', 'infinity']);
  run('docker', ['cp', path.join(REPO_ROOT, tarball), `${l.container}:/pkg.tgz`]);
  run('docker', ['exec', l.container, 'npm', 'install', '-g', '/pkg.tgz'], 300_000);
  const version = run('docker', ['exec', l.container, 'kami-lens', '--version']).trim();
  const childShipped = !!runQuiet('docker', [
    'exec', l.container, 'sh', '-c',
    'test -s /usr/local/lib/node_modules/kami-lens/dist/checkpoint-child.js && echo yes',
  ]).includes('yes');
  return { version, childShipped };
}

const steps: Record<string, boolean> = {};
const detail: Record<string, unknown> = { tarball, primaryImage: PRIMARY_IMAGE, legacyImage: LEGACY_IMAGE };

// ========================================================= PRIMARY leg
const primary = leg(PRIMARY_IMAGE, 'kami-lens-g5a');
const polls: { atSeconds: number; state: string; rc: number }[] = [];
let coldSeconds = -1;
let savedLog = '';
let diagnosis: string | undefined;

try {
  const { version, childShipped } = await install(primary);
  steps.install = true;
  steps.version = version.includes('kami-lens') && /[0-9a-f]{40}/.test(version);
  steps.checkpointChildShipped = childShipped;
  detail.primaryNode = runQuiet('docker', ['exec', primary.container, 'node', '-v']).trim();
  detail.primaryVersionLine = version;
  // THE NUMBER THIS LEG TURNS ON: what Node gives itself here, before the
  // daemon does anything about it
  detail.heapLimitBeforeMb = primary.heapLimitMb();
  console.log(
    `[g5.a] ${PRIMARY_IMAGE} (${detail.primaryNode}): node's default heap cap ` +
      `${detail.heapLimitBeforeMb} MB, cold-boot floor ${COLD_BOOT_HEAP_FLOOR_MB} MB`
  );

  run('docker', ['exec', '-d', primary.container, 'sh', '-c', `kami-lens daemon > ${DAEMON_LOG} 2>&1`]);
  steps.daemonStarted = true;

  const t0 = Date.now();
  let live = false;
  for (let i = 0; i < 100 && Date.now() - t0 < LIVE_BUDGET_MS; i++) {
    await sleep(5000);
    // READ THE STATE, DO NOT INFER IT FROM AN EXIT CODE. `kami-lens health`
    // PRINTS the state and exits 0 only on LIVE (src/cli.ts); checking the
    // exit code alone once recorded `live: true` for a daemon that never
    // left BACKFILL and died at 61 %.
    let probe: { state: string; rc: number };
    try {
      probe = { state: lastLine(run('docker', ['exec', primary.container, 'kami-lens', 'health'], 20_000)), rc: 0 };
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      probe = { state: lastLine(err.stdout ?? ''), rc: err.status ?? -1 };
    }
    polls.push({ atSeconds: Math.round((Date.now() - t0) / 1000), ...probe });
    if (probe.state === 'LIVE' && probe.rc === 0) {
      live = true;
      break;
    }
    if (!primary.hasNode()) {
      diagnosis = 'the daemon process exited before reaching LIVE';
      break;
    }
  }
  coldSeconds = Math.round((Date.now() - t0) / 1000);
  steps.live = live;
  if (!live) diagnosis ??= `daemon did not reach LIVE within ${LIVE_BUDGET_MS / 1000} s`;

  if (live) {
    // §3.1: the heap is the daemon's OWN doing, and this is the datum that
    // proves it — a FRESH node process in the same container still gets
    // Node's default, so the daemon's limit below is not an image-wide
    // setting leaking in. Named for what it measures: the first cut called
    // it `heapLimitAfterMb`, which read as the daemon's limit AFTER the
    // re-exec and so contradicted the `heap.limitMb` two lines below it.
    detail.freshProcessHeapLimitMb = primary.heapLimitMb();
    const statusOut = run('docker', ['exec', primary.container, 'kami-lens', 'status'], 60_000);
    const status = JSON.parse(statusOut) as {
      ok: boolean;
      data: { heap?: { limitMb?: number; source?: string }; checkpointCount?: number; bootstrapMode?: string };
    };
    detail.heap = status.data.heap;
    detail.checkpointCount = status.data.checkpointCount;
    detail.bootstrapMode = status.data.bootstrapMode;
    // the daemon raised its OWN cap: Node's default was below the floor and
    // what it now runs under is not
    steps.heapSelfConfigured = status.data.heap?.source === 'self-configured';
    steps.heapAtOrAboveFloor = (status.data.heap?.limitMb ?? 0) >= COLD_BOOT_HEAP_FLOOR_MB;
    steps.heapReported = typeof status.data.heap?.limitMb === 'number';
    // ruling C: the counter the daemon had kept since 0.2.0 without serving
    steps.checkpointCountServed = typeof status.data.checkpointCount === 'number';
    // and the re-exec said so in the log, both halves
    const log = primary.log();
    steps.reexecLogged =
      /restarting in place with --max-old-space-size=/.test(log) &&
      /heap limit is now \d+ MB \(self-configured/.test(log);
  }

  try {
    if (!live) throw new Error('skipped: the daemon never reached LIVE');
    const itemsOut = run('docker', ['exec', primary.container, 'kami-lens', 'items'], 60_000);
    const response = JSON.parse(itemsOut) as { ok: boolean; data: { items: unknown[] } };
    steps.queryOk = response.ok === true;
    const ajv = new Ajv({ strict: true, allErrors: true });
    steps.querySchemaValid = ajv.validate(loadSchema('items'), response.data) as boolean;
    steps.queryNonEmpty = response.data.items.length > 100;
  } catch (e) {
    steps.queryOk = false;
    detail.queryError = e instanceof Error ? e.message : String(e);
  }
} finally {
  savedLog = primary.log();
  try {
    await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
    await fs.writeFile(path.join(ARTIFACTS_DIR, 'g5a-daemon.log'), savedLog);
  } catch {
    /* the tail still reaches the measurement */
  }
  runQuiet('docker', ['rm', '-f', primary.container]);
}

// ========================================================== LEGACY leg
// The refusal, and it must be fast. Nothing here waits for a daemon: the
// point is that there is no daemon to wait for.
const legacy = leg(LEGACY_IMAGE, 'kami-lens-g5a-legacy');
try {
  const { version } = await install(legacy);
  detail.legacyNode = runQuiet('docker', ['exec', legacy.container, 'node', '-v']).trim();
  detail.legacyVersionLine = version;
  detail.legacyHeapLimitMb = legacy.heapLimitMb();

  const started = Date.now();
  let rc = 0;
  let output = '';
  try {
    output = run('docker', ['exec', legacy.container, 'kami-lens', 'daemon'], 60_000);
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    rc = err.status ?? -1;
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  const refusedInMs = Date.now() - started;
  detail.legacyRefusalMs = refusedInMs;
  detail.legacyExitCode = rc;
  detail.legacyOutput = output.split('\n').filter(Boolean).slice(-6);

  steps.legacyRefused = rc !== 0;
  steps.legacyRefusedFast = refusedInMs < REFUSAL_BUDGET_MS;
  steps.legacyNamedTheCode = output.includes('ERR_INSUFFICIENT_MEMORY');
  // THE REMEDY IS THE CONTRACT: a refusal without the fix is a wall
  steps.legacyGaveTheRemedy =
    output.includes(`NODE_OPTIONS=--max-old-space-size=${DAEMON_HEAP_TARGET_MB}`) &&
    output.includes('kami-lens daemon');
  steps.legacyNamedExecve = /22\.15/.test(output);
  // and it must NOT have started loading anything
  steps.legacyLoadedNothing = !/Querying for State|cold boot/.test(output);
} finally {
  runQuiet('docker', ['rm', '-f', legacy.container]);
}

const oom = /Ineffective mark-compacts near heap limit|heap out of memory/.test(savedLog);
const match = Object.values(steps).every(Boolean);
await writeMeasurement('g5a-cleanroom', {
  ...detail,
  ...(diagnosis ? { diagnosis } : {}),
  timeToLiveSeconds: coldSeconds,
  healthPolls: polls,
  oomInDaemonLog: oom,
  daemonLogTail: savedLog.split('\n').slice(-30),
  daemonLogSaved: path.join(ARTIFACTS_DIR, 'g5a-daemon.log'),
  floors: { coldBootHeapFloorMb: COLD_BOOT_HEAP_FLOOR_MB, daemonHeapTargetMb: DAEMON_HEAP_TARGET_MB },
  steps,
  match,
});
if (!match) {
  fail('G5.a', {
    ...(diagnosis ? { reason: diagnosis } : {}),
    steps,
    heapLimitBeforeMb: detail.heapLimitBeforeMb,
    freshProcessHeapLimitMb: detail.freshProcessHeapLimitMb,
    heap: detail.heap,
    oomInDaemonLog: oom,
    ...(oom
      ? {
          note:
            'the daemon still ran out of JS heap during the cold load — the self-sizing in ' +
            'src/heap.ts either did not fire or did not raise it far enough.',
        }
      : {}),
    legacy: {
      refusalMs: detail.legacyRefusalMs,
      exitCode: detail.legacyExitCode,
      output: detail.legacyOutput,
    },
    daemonLogTail: savedLog.split('\n').slice(-30),
  });
}
pass('G5.a', {
  timeToLiveSeconds: coldSeconds,
  heapLimitBeforeMb: detail.heapLimitBeforeMb,
  heap: detail.heap,
  legacyRefusalMs: detail.legacyRefusalMs,
  legacyExitCode: detail.legacyExitCode,
});
process.exit(0);
