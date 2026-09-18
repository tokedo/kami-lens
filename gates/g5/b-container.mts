// Gate G5.b [live] — container lifecycle. Build the image; assert the image
// installed the version this source tree declares; run with a mounted data
// volume; reach LIVE (healthcheck healthy, bootstrapMode 'cold' on the fresh
// volume); restart the container; status must report an incremental (warm)
// bootstrap and beat the cold time-to-healthy; healthcheck goes healthy again.
//
// 0.6.3 ADDS A THIRD PHASE: a PACKAGED CHECKPOINT ACTUALLY RUNS. The
// periodic checkpoint forks dist/checkpoint-child.js (divergence 16), and
// nothing in the first two phases would notice if that fork were broken —
// `stop()` logs a failed final checkpoint and carries on, and the warm boot
// after it resumes from the bootstrap save either way, so cold-healthy,
// warm-healthy and warm-beats-cold would all still pass while the daemon
// had silently stopped checkpointing. So a third boot runs on the same
// volume with a SHORTENED interval and the gate waits for a checkpoint to
// complete: `checkpointCount` must advance, the checkpoint's block must
// advance with it, the off-thread log line must be there, and no
// 'checkpoint failed' line may be. It is deliberately the LAST phase, so
// the cold/warm timings above are measured without a checkpoint competing
// for the box.

// THE VERSION ASSERTION IS NOT DECORATION (0.5.0). Two stale release
// tarballs were tracked in git; `COPY . .` carried them into the build stage
// beside the freshly packed one, and `npm install -g /tmp/kami-lens-*.tgz`
// installed all three — so which version a VM actually ran came down to
// install ordering. Four byte-identical builds of one image produced 0.4.0,
// 0.2.0, 0.1.0 and 0.2.0, and nothing anywhere said so. The Dockerfile now
// fails the build on an ambiguous glob or a version mismatch; this asserts
// the same thing from OUTSIDE the image, because a build-time check that is
// itself part of the thing being tested is not independent evidence.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fail, pass, REPO_ROOT, sleep, writeMeasurement } from '../g1/lib.mts';

const IMAGE = 'kami-lens:g5';
const CONTAINER = 'kami-lens-g5b';
const VOLUME = 'kami-lens-g5b-data';
let versionCheck: Record<string, string> = {};
const run = (cmd: string, args: string[], timeoutMs = 120_000): string =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, cwd: REPO_ROOT });

try {
  run('docker', ['info'], 30_000);
} catch {
  fail('G5.b', { reason: 'docker unavailable — start colima (--memory 8) first' });
}

const health = (): string => {
  try {
    return run('docker', ['inspect', '--format', '{{.State.Health.Status}}', CONTAINER]).trim();
  } catch {
    return 'unknown';
  }
};

const waitHealthy = async (capS: number): Promise<number> => {
  const t0 = Date.now();
  for (;;) {
    const h = health();
    if (h === 'healthy') return Math.round((Date.now() - t0) / 1000);
    if ((Date.now() - t0) / 1000 > capS) return -1;
    await sleep(5000);
  }
};

const statusField = <T,>(field: string): T => {
  const out = run('docker', ['exec', CONTAINER, 'kami-lens', 'status'], 60_000);
  const resp = JSON.parse(out) as { ok: boolean; data: Record<string, T> };
  if (!resp.ok) throw new Error('status query failed');
  return resp.data[field];
};

/** Interval for the third phase. Short enough to wait for, long enough
 * that a checkpoint is not still running when the phase ends (daemon.ts
 * skips an interval while one is in flight, which would measure a
 * different thing). */
const CHECKPOINT_INTERVAL_MS = 45_000;
type CheckpointBlock = { blockNumber: number; inFlight?: boolean } | null;

const steps: Record<string, boolean> = {};
let coldSeconds = -1;
let warmSeconds = -1;
let checkpointPhase: Record<string, unknown> = {};
try {
  run('docker', ['rm', '-f', CONTAINER]);
} catch { /* none */ }
try {
  run('docker', ['volume', 'rm', VOLUME]);
} catch { /* none */ }

try {
  console.log('building image (npm ci + build + pack inside — several minutes)');
  run('docker', ['build', '-t', IMAGE, '.'], 900_000);
  steps.imageBuilt = true;

  // --- the installed artifact IS the declared one --------------------------
  {
    const declared = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
    ).version as string;
    const reported = run('docker', ['run', '--rm', '--entrypoint', 'kami-lens', IMAGE, '--version'])
      .trim();
    // `kami-lens <version> (upstream Asphodel-OS/kamigotchi @ <pin>)`
    const installed = reported.split(/\s+/)[1] ?? '';
    const installedPkg = run('docker', [
      'run', '--rm', '--entrypoint', 'node', IMAGE,
      '-p', "require('/usr/local/lib/node_modules/kami-lens/package.json').version",
    ]).trim();
    const tarballs = run('docker', [
      'run', '--rm', '--entrypoint', 'sh', IMAGE,
      '-c', 'ls /usr/local/lib/node_modules | grep -c "^kami-lens$" || true',
    ]).trim();
    versionCheck = { declared, reported, installed, installedPkg, installedPackages: tarballs };
    if (installed !== declared || installedPkg !== declared) {
      fail('G5.b', {
        reason: 'the image installed a different version than this tree declares',
        ...versionCheck,
      });
    }
    if (tarballs !== '1') {
      fail('G5.b', { reason: 'expected exactly one installed kami-lens package', ...versionCheck });
    }
    steps.versionMatches = true;
  }

  run('docker', ['volume', 'create', VOLUME]);
  run('docker', ['run', '-d', '--name', CONTAINER, '-v', `${VOLUME}:/data`, IMAGE]);
  steps.containerUp = true;

  coldSeconds = await waitHealthy(600);
  steps.coldHealthy = coldSeconds >= 0;
  if (!steps.coldHealthy) fail('G5.b', { reason: 'healthcheck never went healthy (cold)', coldSeconds });
  steps.coldMode = statusField<string>('bootstrapMode') === 'cold';

  run('docker', ['restart', CONTAINER], 120_000);
  warmSeconds = await waitHealthy(600);
  steps.warmHealthy = warmSeconds >= 0;
  if (!steps.warmHealthy) fail('G5.b', { reason: 'healthcheck never went healthy (warm)', warmSeconds });
  steps.warmMode = statusField<string>('bootstrapMode') === 'warm';
  steps.warmResumeBlock = statusField<number>('resumeFromBlock') > 0;
  steps.warmBeatsCold = warmSeconds < coldSeconds;

  // --- phase 3: a checkpoint runs, in the packaged form (divergence 16) --
  {
    const childPath = '/usr/local/lib/node_modules/kami-lens/dist/checkpoint-child.js';
    try {
      run('docker', ['exec', CONTAINER, 'test', '-s', childPath]);
      steps.checkpointChildShipped = true;
    } catch {
      steps.checkpointChildShipped = false;
      fail('G5.b', { reason: `${childPath} is not in the image — divergence 16 cannot run`, steps });
    }

    // a third boot on the SAME volume, with the interval shortened
    run('docker', ['rm', '-f', CONTAINER]);
    run('docker', [
      'run', '-d', '--name', CONTAINER,
      '-v', `${VOLUME}:/data`,
      '-e', `KAMI_LENS_CHECKPOINT_INTERVAL_MS=${CHECKPOINT_INTERVAL_MS}`,
      IMAGE,
    ]);
    const thirdSeconds = await waitHealthy(600);
    steps.checkpointBootHealthy = thirdSeconds >= 0;
    if (!steps.checkpointBootHealthy) {
      fail('G5.b', { reason: 'the checkpoint-phase boot never went healthy', thirdSeconds, steps });
    }
    // WHAT COUNTS AS "A PERIODIC CHECKPOINT RAN", using only what the
    // daemon actually SERVES. The first attempt asked for
    // `status.checkpointCount`, which the daemon keeps and never surfaces
    // (DaemonStatus has it; buildStatusData does not emit it and the
    // schema does not declare it) — so the check read `undefined >
    // undefined` and failed a phase whose every other assertion passed.
    // Reported as a finding; not worked around by adding a served field
    // mid-gate.
    //
    // The two facts that ARE observable, and together they are stronger
    // than a counter: this container's log gains a "checkpoint written
    // off-thread" line (the child forked, ran and reported — the whole of
    // divergence 16), and `status.checkpoint.blockNumber` advances (it
    // wrote a NEWER image, not the same one again). The container is fresh
    // for this phase, so its log starts empty and any such line is a
    // PERIODIC checkpoint: a warm boot ADOPTS the stored one and writes
    // nothing.
    const offThreadCount = (): number =>
      run('docker', ['logs', CONTAINER], 120_000)
        .split('\n')
        .filter((l) => l.includes('checkpoint written off-thread')).length;
    const blockAtLive = (statusField<CheckpointBlock>('checkpoint'))?.blockNumber ?? 0;
    const offThreadAtLive = offThreadCount();
    let blockNow = blockAtLive;
    let offThreadNow = offThreadAtLive;
    const deadline = Date.now() + CHECKPOINT_INTERVAL_MS * 4;
    while (Date.now() < deadline) {
      await sleep(5_000);
      offThreadNow = offThreadCount();
      blockNow = (statusField<CheckpointBlock>('checkpoint'))?.blockNumber ?? 0;
      console.log(
        `[g5.b] off-thread checkpoints ${offThreadAtLive} -> ${offThreadNow}, ` +
          `checkpoint block ${blockAtLive} -> ${blockNow}`
      );
      if (offThreadNow > offThreadAtLive && blockNow > blockAtLive) break;
    }
    const logs = run('docker', ['logs', CONTAINER], 120_000);
    const offThread = logs.split('\n').filter((l) => l.includes('checkpoint written off-thread'));
    const failedLines = logs.split('\n').filter((l) => l.includes('checkpoint failed'));
    checkpointPhase = {
      thirdSeconds,
      blockAtLive,
      blockNow,
      offThreadAtLive,
      offThreadNow,
      offThreadSample: offThread.slice(-1),
      failedLines,
      // the child's own peak RSS, as it reported it — the number a memory
      // budget for this container has to cover on top of the daemon's
      // searched over the WHOLE log, not over the matched lines: the
      // daemon pretty-prints that object across several lines, so
      // `childPeakRssKb` sits BELOW the line the filter matched (it came
      // back null on the first recorded run for exactly that reason)
      childPeakRssKb: /childPeakRssKb: (\d+)/.exec(logs)?.[1] ?? null,
    };
    steps.periodicCheckpointRan = offThreadNow > offThreadAtLive;
    steps.checkpointRanOffThread = offThread.length > 0;
    steps.noCheckpointFailures = failedLines.length === 0;
    steps.checkpointBlockAdvanced = blockNow > blockAtLive;
  }
} finally {
  try {
    run('docker', ['rm', '-f', CONTAINER]);
  } catch { /* gone */ }
  try {
    run('docker', ['volume', 'rm', VOLUME]);
  } catch { /* gone */ }
}

await writeMeasurement('g5b-container', {
  image: IMAGE,
  versionCheck,
  coldSeconds,
  warmSeconds,
  checkpointPhase,
  steps,
  match: Object.values(steps).every(Boolean),
});
if (!Object.values(steps).every(Boolean)) {
  fail('G5.b', { steps, coldSeconds, warmSeconds, checkpointPhase });
}
pass('G5.b', { coldSeconds, warmSeconds, checkpointPhase, ...steps });
process.exit(0);
