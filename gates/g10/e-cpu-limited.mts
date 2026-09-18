// Gate G10.e [live, manual] — a cold CDN boot under a CPU limit, and a
// `status` poll straight through a periodic checkpoint. 0.6.3, DESIGN §3.1,
// §3.5; SPEC §3 ("status answers within N s at all times").
//
// WHY THIS GATE EXISTS. G10.a passes comfortably on this Mac and could not
// see either of the defects 0.6.3 fixes. On the VM (2 vCPU) the same boot
// took 271 s instead of 118 s because the daemon's own 90-s pre-LIVE stall
// watchdog tore down a HEALTHY load (L-11), and the same daemon stops
// answering `status` for 20-32 s every ten minutes while it writes a
// checkpoint. The Mac's longest progress silence was 2.4 s and its
// checkpoint silence 4-5 s. A gate that only ever runs on the fast machine
// is a gate that ships the slow machine's bugs, so this one puts the
// PACKAGED daemon on one CPU and measures both.
//
// WHY --cpuset-cpus AND NOT JUST --cpus. `--cpus 1` is a cgroup CPU QUOTA,
// and `os.availableParallelism()` — which divergence 15 caps the in-flight
// chunk count from — reads the process's CPU AFFINITY, which a quota does
// not narrow. Under `--cpus 1` alone the loader would still see the host's
// core count and keep 6 bodies in flight, so the leg would measure a
// configuration no small VM actually has. `--cpuset-cpus` pins the
// affinity, which is what kami-factory's 2 vCPUs really are. Both are
// passed: the quota bounds the throughput, the affinity bounds the
// parallelism.
//
// WHAT IS ASSERTED (all four, or the gate fails):
//   1. LIVE on bootstrap attempt ONE — no `pre-LIVE stall` line and no
//      `bootstrap attempt … failed` line anywhere in the container's log.
//   2. ZERO `[cdn] chunk retry` lines attributable to a TimeoutError. A
//      retry from a 5xx or a reset connection is the CDN's business and does
//      not fail this; a TimeoutError is the self-inflicted one (divergences
//      13 and 15 exist to remove exactly it).
//   3. The longest PROGRESS-SILENT interval before LIVE is under 30 s —
//      a third of PRELIVE_STALL_MS, so the bound has real margin rather
//      than a near miss (divergence 14).
//   4. Across one full periodic checkpoint AFTER LIVE, the longest interval
//      with no `status` answer is under 2 s (divergence 16). The poll also
//      has to SEE the checkpoint: a run where `checkpoint.inFlight` was
//      never true proves nothing and fails.
//
// The recorded numbers (cold->LIVE, the load profile, peak container
// memory, both silence figures) go to
// docs/measurements/g10e-cdn-cold-boot-1cpu-<date>.json.
//
// CDN PULLS ARE RATIONED. Each run of this leg is one ~80 MB CloudFront
// pull. THREE IN TOTAL, enforced mechanically by a counter artifact, not by
// remembering — the point is one clean record, not a sample.
//
// TOUCHES NO LIVE DAEMON. Everything happens in a container on a docker
// volume of its own. Nothing reads or writes
// ~/Library/Application Support/kami-lens, and no signal is sent to
// anything outside the container this leg created.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { ARTIFACTS_DIR, fail, pass, REPO_ROOT, sleep, writeMeasurement } from '../g1/lib.mts';

const execFileAsync = promisify(execFile);

const IMAGE = 'kami-lens:g10e';
const CONTAINER = 'kami-lens-g10e';
const VOLUME = 'kami-lens-g10e-data';
const POLL_OUT = '/tmp/g10e-poll.jsonl';

/** The whole point of the leg. `--cpuset-cpus 0` is the load-bearing one:
 * it pins the AFFINITY, which is what `os.availableParallelism()` reads and
 * therefore what divergence 15's cap turns on; `--cpus` bounds the quota
 * alongside it so throughput and parallelism agree. ONE core is harsher
 * than the 2-vCPU VM on purpose (lab ruling, 2026-09-18). */
const CPUS = process.env.G10E_CPUS ?? '1';
const CPUSET = process.env.G10E_CPUSET ?? '0';
const MEMORY = process.env.G10E_MEMORY ?? '6g';

/** Shortened so one full checkpoint fits inside the leg instead of the
 * default ten minutes. Not shortened FURTHER than this: a checkpoint that
 * overlaps the next interval would measure a different thing (daemon.ts
 * skips an interval while one is in flight). */
const CHECKPOINT_INTERVAL_MS = Number(process.env.G10E_CHECKPOINT_INTERVAL_MS ?? 180_000);

/** Bounds. Generous against a 1-CPU cold boot measured at 118 s clean on
 * 2 vCPUs — this is a refuse-to-hang bound, not a performance target. */
const LIVE_BUDGET_MS = Number(process.env.G10E_LIVE_BUDGET_MS ?? 900_000);
const CHECKPOINT_WAIT_MS = Number(process.env.G10E_CHECKPOINT_WAIT_MS ?? 900_000);

/** The three assertions with numbers on them. */
const MAX_PROGRESS_SILENCE_MS = 30_000;
const MAX_STATUS_GAP_MS = 2_000;
const MAX_RUNS = 3;

type Sample = {
  t: string;
  latencyMs: number;
  ok: boolean;
  state?: string | null;
  percentage?: number | null;
  msg?: string | null;
  liveBlockNumber?: number | null;
  bootstrapMode?: string | null;
  startedAt?: string | null;
  liveAt?: string | null;
  checkpointInFlight?: boolean | null;
  checkpointCount?: number | null;
  lastFullLoad?: Record<string, unknown> | null;
  degraded?: string[] | null;
  /** sum of VmRSS over every node process in the container except the
   * poller — i.e. the daemon plus, during a checkpoint, its child */
  rssKb?: number;
  procs?: { pid: number; rssKb: number }[];
  error?: string;
};

const docker = async (args: string[], timeoutMs = 120_000): Promise<string> => {
  const { stdout } = await execFileAsync('docker', args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    cwd: REPO_ROOT,
  });
  return stdout;
};

const dockerQuiet = async (args: string[], timeoutMs = 120_000): Promise<string> => {
  try {
    return await docker(args, timeoutMs);
  } catch {
    return '';
  }
};

// ------------------------------------------------------------ pull rationing

const RUN_LEDGER = path.join(ARTIFACTS_DIR, 'g10e-runs.json');

async function claimRun(): Promise<number> {
  let runs: { runs: string[] } = { runs: [] };
  try {
    runs = JSON.parse(await fs.readFile(RUN_LEDGER, 'utf8')) as { runs: string[] };
  } catch {
    /* first run */
  }
  if (runs.runs.length >= MAX_RUNS && process.env.G10E_FORCE !== '1') {
    fail('G10.e', {
      reason: `this leg has already made ${runs.runs.length} CDN pulls (cap ${MAX_RUNS}) — see ${RUN_LEDGER}`,
      runs: runs.runs,
      note: 'each run is a ~80 MB CloudFront pull. G10E_FORCE=1 only with a reason on the record.',
    });
  }
  runs.runs.push(new Date().toISOString());
  await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
  await fs.writeFile(RUN_LEDGER, JSON.stringify(runs, null, 2) + '\n');
  return runs.runs.length;
}

// --------------------------------------------------------------- measurement

/** Longest interval between consecutive samples whose FINGERPRINT changed —
 * the same `state|percentage|msg|liveBlockNumber` the daemon's own stall
 * watchdog compares (daemon.ts progressKey, gates/g10/lib.mts). Only
 * samples up to LIVE count: after LIVE there is no bound to respect. */
function progressSilence(samples: Sample[]): { maxMs: number; on: string } {
  let lastKey = '';
  let lastAt = 0;
  let maxMs = 0;
  let on = '';
  for (const s of samples) {
    if (!s.ok) continue;
    const at = Date.parse(s.t);
    const key = `${s.state}|${s.percentage}|${s.msg}|${s.liveBlockNumber}`;
    if (lastAt === 0) {
      lastKey = key;
      lastAt = at;
      continue;
    }
    if (key === lastKey) continue;
    if (at - lastAt > maxMs) {
      maxMs = at - lastAt;
      on = lastKey;
    }
    lastKey = key;
    lastAt = at;
    if (s.state === 'LIVE') break;
  }
  return { maxMs, on };
}

/** Longest stretch with no ANSWERED status, over a window. A sample that
 * failed contributes its own latency (the poller's timeout) plus the gap to
 * the next answered one, which is exactly what a watchdog would have
 * experienced. */
function statusGap(samples: Sample[], fromMs: number, toMs: number): { maxMs: number; at: string } {
  let lastOkAt = 0;
  let maxMs = 0;
  let at = '';
  for (const s of samples) {
    const t = Date.parse(s.t);
    if (t < fromMs || t > toMs) continue;
    if (!s.ok) continue;
    const answeredAt = t + s.latencyMs;
    if (lastOkAt !== 0 && t - lastOkAt > maxMs) {
      maxMs = t - lastOkAt;
      at = s.t;
    }
    lastOkAt = answeredAt;
  }
  return { maxMs, at };
}

const jsonAfter = (line: string): Record<string, unknown> | null => {
  const brace = line.indexOf('{');
  if (brace < 0) return null;
  try {
    return JSON.parse(line.slice(brace)) as Record<string, unknown>;
  } catch {
    return null;
  }
};

// --------------------------------------------------------------------- run

try {
  await docker(['info'], 30_000);
} catch {
  fail('G10.e', { reason: 'docker unavailable — start colima (--memory 8) first' });
}

const runNumber = await claimRun();
console.log(`[g10.e] CDN pull ${runNumber}/${MAX_RUNS} for this leg`);
console.log(`[g10.e] limits: --cpus ${CPUS} --cpuset-cpus ${CPUSET} --memory ${MEMORY}`);
console.log(`[g10.e] host has ${os.availableParallelism()} available CPUs (the container must see 1)`);

await dockerQuiet(['rm', '-f', CONTAINER]);
await dockerQuiet(['volume', 'rm', VOLUME]);

const checks: Record<string, boolean> = {};
const detail: Record<string, unknown> = {
  cpus: CPUS,
  cpuset: CPUSET,
  memory: MEMORY,
  checkpointIntervalMs: CHECKPOINT_INTERVAL_MS,
  run: runNumber,
};
let samples: Sample[] = [];
let logs = '';
let peakMemBytes = 0;

const readSamples = async (): Promise<Sample[]> => {
  const raw = await dockerQuiet(['exec', CONTAINER, 'cat', POLL_OUT], 60_000);
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Sample;
      } catch {
        return null;
      }
    })
    .filter((s): s is Sample => s !== null);
};

/** Container memory from the cgroup, which is what the VM's budget is read
 * against — and which now has to cover the daemon AND its checkpoint child
 * (0.6.3, divergence 16). `docker stats` is sampled rather than `ps`'d
 * inside, so a child that has already exited still counted while it ran. */
const sampleMem = async (): Promise<void> => {
  const raw = await dockerQuiet(
    ['stats', '--no-stream', '--format', '{{.MemUsage}}', CONTAINER],
    30_000
  );
  const m = /^([\d.]+)\s*([KMG]i?B)/i.exec(raw.trim());
  if (!m) return;
  const unit = m[2]!.toUpperCase();
  const scale = unit.startsWith('G') ? 1024 ** 3 : unit.startsWith('M') ? 1024 ** 2 : 1024;
  peakMemBytes = Math.max(peakMemBytes, Number(m[1]) * scale);
};

try {
  console.log('[g10.e] building the image (npm ci + build + pack inside — several minutes)');
  await docker(['build', '-t', IMAGE, '.'], 1_800_000);
  checks.imageBuilt = true;

  // the child entry must be IN the packaged artifact — a checkpoint that
  // cannot fork is a checkpoint that does not happen, and this leg is the
  // one that would discover it 20 minutes in
  const childLs = await dockerQuiet([
    'run', '--rm', '--entrypoint', 'sh', IMAGE,
    '-c', 'ls -l /usr/local/lib/node_modules/kami-lens/dist/checkpoint-child.js || true',
  ]);
  detail.checkpointChildInImage = childLs.trim();
  checks.checkpointChildPackaged = childLs.includes('checkpoint-child.js');
  if (!checks.checkpointChildPackaged) {
    fail('G10.e', {
      reason: 'dist/checkpoint-child.js is not in the installed package — divergence 16 cannot run',
      ls: childLs,
    });
  }

  await docker(['volume', 'create', VOLUME]);
  await docker([
    'run', '-d', '--name', CONTAINER,
    '--cpus', CPUS,
    '--cpuset-cpus', CPUSET,
    '--memory', MEMORY,
    '-v', `${VOLUME}:/data`,
    // default config otherwise: the state CDN is ON by default since 0.6.2,
    // and this leg proves the DEFAULT cold boot on a small machine
    '-e', `KAMI_LENS_CHECKPOINT_INTERVAL_MS=${CHECKPOINT_INTERVAL_MS}`,
    IMAGE,
  ]);
  checks.containerUp = true;
  const t0 = Date.now();

  // what the container itself thinks it has, recorded rather than assumed
  detail.containerAvailableParallelism = (
    await dockerQuiet(['exec', CONTAINER, 'node', '-p', 'os.availableParallelism()'], 60_000)
  ).trim();

  // the poller, started immediately — it retries until the socket exists,
  // so its first samples cover the pre-socket window honestly
  await docker(['cp', path.join(REPO_ROOT, 'gates', 'g10', 'e-poller.cjs'), `${CONTAINER}:/tmp/poller.cjs`]);
  await docker([
    'exec', '-d', CONTAINER, 'node', '/tmp/poller.cjs',
    '--data-dir', '/data', '--out', POLL_OUT, '--interval-ms', '1000', '--timeout-ms', '10000',
  ]);
  console.log('[g10.e] poller running; waiting for LIVE');

  // ---- to LIVE -----------------------------------------------------------
  let live: Sample | undefined;
  while (Date.now() - t0 < LIVE_BUDGET_MS) {
    await sleep(5_000);
    await sampleMem();
    samples = await readSamples();
    live = samples.find((s) => s.ok && s.state === 'LIVE');
    if (live) break;
    const last = [...samples].reverse().find((s) => s.ok);
    console.log(
      `[g10.e] ${Math.round((Date.now() - t0) / 1000)}s: ` +
        (last ? `${last.state} ${last.percentage}% ${last.msg ?? ''}` : 'no answer yet') +
        ` (${samples.length} samples, peak ${(peakMemBytes / 1024 ** 3).toFixed(2)} GiB)`
    );
  }
  logs = await dockerQuiet(['logs', CONTAINER], 120_000);
  checks.reachedLive = !!live;
  if (!live) {
    await writeMeasurement('g10e-cdn-cold-boot-1cpu', {
      ...detail,
      checks,
      samples: samples.length,
      reason: `LIVE not reached within ${LIVE_BUDGET_MS}ms`,
      logTail: logs.split('\n').slice(-60),
    });
    fail('G10.e', { reason: 'LIVE not reached', budgetMs: LIVE_BUDGET_MS });
  }

  // cold->LIVE from the daemon's OWN clock, not the gate's: startedAt and
  // liveAt are what every other G10 record is stated in
  const coldToLiveMs = Date.parse(live!.liveAt!) - Date.parse(live!.startedAt!);
  detail.coldToLiveSeconds = +(coldToLiveMs / 1000).toFixed(1);
  detail.bootstrapMode = live!.bootstrapMode;
  detail.lastFullLoad = live!.lastFullLoad;
  detail.degradedAtLive = live!.degraded;
  console.log(`[g10.e] LIVE after ${detail.coldToLiveSeconds}s`);

  // 1. one attempt, no stall
  const stallLines = logs.split('\n').filter((l) => l.includes('pre-LIVE stall'));
  const retryLines = logs.split('\n').filter((l) => l.includes('bootstrap attempt'));
  detail.preLiveStallLines = stallLines;
  detail.bootstrapRetryLines = retryLines;
  checks.oneBootstrapAttempt = stallLines.length === 0 && retryLines.length === 0;

  // 2. no self-inflicted chunk timeouts
  const chunkRetries = logs.split('\n').filter((l) => l.includes('[cdn] chunk retry'));
  const timeoutRetries = chunkRetries.filter((l) => l.includes('TimeoutError'));
  detail.chunkRetryLines = chunkRetries;
  detail.chunkTimeoutRetries = timeoutRetries.length;
  checks.noTimeoutChunkRetries = timeoutRetries.length === 0;

  // 3. progress silence before LIVE
  const silence = progressSilence(samples);
  detail.maxProgressSilentMs = silence.maxMs;
  detail.maxProgressSilentOn = silence.on;
  checks.progressSilenceUnderBound = silence.maxMs < MAX_PROGRESS_SILENCE_MS;

  // the load profile and the concurrency the loader actually chose
  const profileLine = [...logs.split('\n')].reverse().find((l) => l.includes('[cdn] load profile'));
  detail.loadProfile = profileLine ? jsonAfter(profileLine) : null;
  const concurrencyLine = [...logs.split('\n')]
    .reverse()
    .find((l) => l.includes('[cdn] chunk fetch concurrency'));
  detail.chunkFetchConcurrency = concurrencyLine ? jsonAfter(concurrencyLine) : null;
  checks.servedByCdn = /full load served by CDN/.test(logs);

  // ---- through one periodic checkpoint -----------------------------------
  console.log(
    `[g10.e] waiting for a full periodic checkpoint (interval ${CHECKPOINT_INTERVAL_MS}ms)`
  );
  const liveAtMs = Date.parse(live!.liveAt!);
  const cpWaitStart = Date.now();
  let sawInFlight = false;
  let sawFinished = false;
  while (Date.now() - cpWaitStart < CHECKPOINT_WAIT_MS) {
    await sleep(5_000);
    await sampleMem();
    samples = await readSamples();
    const after = samples.filter((s) => s.ok && Date.parse(s.t) > liveAtMs);
    // inFlight true at some point, and false again afterwards = one whole
    // checkpoint inside the window. Read from `checkpoint.inFlight`, which
    // IS served — `status.checkpointCount` exists on DaemonStatus and is
    // never emitted (found in G5.b), so nothing here asks for it.
    for (const s of after) {
      if (s.checkpointInFlight === true) sawInFlight = true;
      else if (sawInFlight && s.checkpointInFlight === false) sawFinished = true;
    }
    const procPeak = Math.max(0, ...after.map((s) => s.rssKb ?? 0));
    console.log(
      `[g10.e] ${Math.round((Date.now() - cpWaitStart) / 1000)}s post-LIVE: ` +
        `inFlight seen ${sawInFlight}, finished ${sawFinished}, ` +
        `peak node RSS ${(procPeak / 1024 / 1024).toFixed(2)} GiB`
    );
    if (sawInFlight && sawFinished) break;
  }
  const windowEndMs = Date.now();
  samples = await readSamples();
  logs = await dockerQuiet(['logs', CONTAINER], 120_000);

  // 4. status never went quiet for long, across that window
  const gap = statusGap(samples, liveAtMs, windowEndMs);
  detail.postLiveWindowSeconds = +((windowEndMs - liveAtMs) / 1000).toFixed(1);
  detail.maxStatusGapMs = gap.maxMs;
  detail.maxStatusGapAt = gap.at;
  detail.statusSamplesPostLive = samples.filter((s) => Date.parse(s.t) > liveAtMs).length;
  detail.statusFailuresPostLive = samples.filter(
    (s) => !s.ok && Date.parse(s.t) > liveAtMs
  ).length;
  detail.maxStatusLatencyMsPostLive = Math.max(
    0,
    ...samples.filter((s) => s.ok && Date.parse(s.t) > liveAtMs).map((s) => s.latencyMs)
  );
  checks.checkpointObserved = sawInFlight && sawFinished;
  checks.statusAnsweredThroughCheckpoint = gap.maxMs < MAX_STATUS_GAP_MS;
  checks.noStatusFailuresPostLive = detail.statusFailuresPostLive === 0;

  // THE COMBINED FIGURE, which is the one a host memory budget is read
  // against: the checkpoint child has its own heap (divergence 16), so a
  // box must hold the daemon AND the child at once. Taken from the
  // poller's own /proc walk — kernel VmRSS per process, summed — rather
  // than from the cgroup total, which also counts page cache.
  const inFlightSamples = samples.filter((s) => s.checkpointInFlight === true);
  const peakSample = samples.reduce<Sample | null>(
    (best, s) => ((s.rssKb ?? 0) > (best?.rssKb ?? 0) ? s : best),
    null
  );
  const peakDuringCheckpoint = inFlightSamples.reduce<Sample | null>(
    (best, s) => ((s.rssKb ?? 0) > (best?.rssKb ?? 0) ? s : best),
    null
  );
  detail.peakNodeRssKb = peakSample?.rssKb ?? 0;
  detail.peakNodeRssGiB = +((peakSample?.rssKb ?? 0) / 1024 / 1024).toFixed(2);
  detail.peakNodeRssAt = peakSample?.t ?? null;
  detail.peakNodeRssProcs = peakSample?.procs ?? null;
  detail.peakDuringCheckpointKb = peakDuringCheckpoint?.rssKb ?? 0;
  detail.peakDuringCheckpointGiB = +((peakDuringCheckpoint?.rssKb ?? 0) / 1024 / 1024).toFixed(2);
  detail.peakDuringCheckpointProcs = peakDuringCheckpoint?.procs ?? null;
  detail.checkpointInFlightSamples = inFlightSamples.length;
  detail.maxNodeProcsSeen = Math.max(0, ...samples.map((s) => s.procs?.length ?? 0));

  const offThread = logs.split('\n').filter((l) => l.includes('checkpoint written off-thread'));
  detail.checkpointLines = offThread;
  detail.peakContainerMemoryBytes = peakMemBytes;
  detail.peakContainerMemoryGiB = +(peakMemBytes / 1024 ** 3).toFixed(2);
  detail.logTail = logs.split('\n').slice(-80);
} finally {
  // the samples file is worth keeping whatever happened
  await dockerQuiet([
    'cp',
    `${CONTAINER}:${POLL_OUT}`,
    path.join(ARTIFACTS_DIR, 'g10e-poll.jsonl'),
  ]);
  await dockerQuiet(['rm', '-f', CONTAINER]);
  await dockerQuiet(['volume', 'rm', VOLUME]);
}

const match = Object.values(checks).every(Boolean);
await writeMeasurement('g10e-cdn-cold-boot-1cpu', {
  ...detail,
  bounds: {
    maxProgressSilenceMs: MAX_PROGRESS_SILENCE_MS,
    maxStatusGapMs: MAX_STATUS_GAP_MS,
    liveBudgetMs: LIVE_BUDGET_MS,
  },
  samples: samples.length,
  checks,
  match,
});
if (!match) fail('G10.e', { checks, detail });
pass('G10.e', {
  coldToLiveSeconds: detail.coldToLiveSeconds,
  maxProgressSilentMs: detail.maxProgressSilentMs,
  maxStatusGapMs: detail.maxStatusGapMs,
  peakContainerMemoryGiB: detail.peakContainerMemoryGiB,
  chunkTimeoutRetries: detail.chunkTimeoutRetries,
});
process.exit(0);
