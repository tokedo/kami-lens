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

/**
 * How long `status` went unanswered, over a window — THREE numbers,
 * because the first cut of this reported the least meaningful of them.
 *
 *   waitedMs   the longest a single poll waited for its answer. THIS is
 *              the operative one and the one the bound is asserted on: it
 *              is what a watchdog with a timeout actually experiences, and
 *              "the daemon did not answer for N seconds" means this. An
 *              unanswered poll contributes the poller's own timeout.
 *   betweenMs  the longest interval between consecutive ANSWERS arriving.
 *              Includes the poll interval, so on 1 s polling it is
 *              waitedMs plus up to a second of ordinary idleness.
 *   idleMs     answer-to-next-request. What the first version measured,
 *              kept only because it is the one that flatters the result
 *              and should be visible beside the others rather than alone.
 */
function statusGap(
  samples: Sample[],
  fromMs: number,
  toMs: number,
  /** only samples with at most this many node processes in the container —
   * 1 isolates the daemon with nothing else on the core */
  maxProcs = Infinity
): { waitedMs: number; waitedAt: string; betweenMs: number; idleMs: number } {
  let lastAnswerAt = 0;
  let waitedMs = 0;
  let waitedAt = '';
  let betweenMs = 0;
  let idleMs = 0;
  for (const s of samples) {
    const t = Date.parse(s.t);
    if (t < fromMs || t > toMs) continue;
    if ((s.procs?.length ?? 1) > maxProcs) continue;
    // an unanswered poll waited its whole timeout; that IS the silence
    if (s.latencyMs > waitedMs) {
      waitedMs = s.latencyMs;
      waitedAt = s.t;
    }
    if (!s.ok) continue;
    const answeredAt = t + s.latencyMs;
    if (lastAnswerAt !== 0) {
      betweenMs = Math.max(betweenMs, answeredAt - lastAnswerAt);
      idleMs = Math.max(idleMs, t - lastAnswerAt);
    }
    lastAnswerAt = answeredAt;
  }
  return { waitedMs, waitedAt, betweenMs, idleMs };
}

/**
 * Read one `log.info(message, object)` payload out of `docker logs`.
 *
 * IT IS NOT JSON AND IT IS NOT ONE LINE. utils/logger writes through
 * console.log, so from OUTSIDE the process the object arrives as Node's
 * own inspect output — unquoted keys, single-quoted strings, and wrapped
 * across lines once it is wide:
 *
 *     [cdn] load profile {
 *       wallSeconds: 16.38,
 *       applyShareOfWall: '70%',
 *       ...
 *     }
 *
 * The first recorded run of this leg took the brace-to-end-of-LINE and
 * JSON.parsed it — which is right for gates/g10/lib.mts, where the gate
 * hosts the daemon in-process and its own console tap renders each arg
 * with JSON.stringify — and here it returned null for both the load
 * profile and the checkpoint line, losing the numbers the leg exists to
 * record. Same source, two different formats; this is the docker-logs one.
 */
const inspectAfter = (lines: string[], needle: string): Record<string, unknown> | null => {
  const at = lines.map((l, i) => ({ l, i })).reverse().find(({ l }) => l.includes(needle))?.i;
  if (at === undefined) return null;
  const brace = lines[at]!.indexOf('{');
  if (brace < 0) return null;
  // accumulate to the closing brace at column 0 of its own line
  const body: string[] = [];
  for (let i = at + 1; i < lines.length && i < at + 200; i++) {
    if (/^\s*\}/.test(lines[i]!)) break;
    body.push(lines[i]!);
  }
  const out: Record<string, unknown> = {};
  for (const raw of body) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.+?),?\s*$/.exec(raw);
    if (!m) continue;
    const value = m[2]!.trim();
    if (/^-?\d+(\.\d+)?$/.test(value)) out[m[1]!] = Number(value);
    else if (/^'.*'$/.test(value) || /^".*"$/.test(value)) out[m[1]!] = value.slice(1, -1);
    else if (value === 'true' || value === 'false') out[m[1]!] = value === 'true';
    else if (value === 'null') out[m[1]!] = null;
    else out[m[1]!] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
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
  const logLines = logs.split('\n');
  detail.loadProfile = inspectAfter(logLines, '[cdn] load profile');
  detail.chunkFetchConcurrency = inspectAfter(logLines, '[cdn] chunk fetch concurrency');
  // REFUSE RATHER THAN RECORD A HOLE. The load profile is the whole
  // point of measuring on one core: parkedSeconds and applySlices are
  // divergence 13's cost, and microsecondsPerValueRow is what this box is
  // compared with the Mac and the VM by. A null here means the parser
  // broke, not that the daemon did, and it must not pass silently.
  checks.loadProfileRecorded =
    !!detail.loadProfile && typeof (detail.loadProfile as Record<string, unknown>).wallSeconds === 'number';
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
  // THE WINDOW THE BOUND IS ABOUT. The brief asks for the longest
  // unanswered gap "across one full periodic checkpoint", and that is what
  // is asserted: first inFlight sample to one sample past the last, so the
  // window covers the fork, the delta, the serialize and the commit.
  //
  // WHY IT IS SCOPED AND NOT THE WHOLE POST-LIVE WINDOW. On ONE core every
  // other process on the box is a competitor, and the image runs its own
  // `HEALTHCHECK CMD kami-lens health` every 30 s — a fresh Node start
  // loading the 1.5 MB bundle, which is heavier than the daemon's answer it
  // is checking. Measured here: the worst post-LIVE wait was 3,001 ms, one
  // second after LIVE, in a sample with a SECOND node process present and
  // no checkpoint in flight, while the worst wait during an actual
  // checkpoint was 443 ms. Asserting over the whole window would be
  // asserting that nothing else may ever run on the core, which is not this
  // release's claim and not a property of the daemon. Both figures are
  // recorded, and so is the daemon's own worst case with nothing else
  // running (`maxStatusWaitAloneMs`) — that one is the honest measure of
  // this daemon, and the healthcheck's cost is a finding, not a pass.
  const inFlightTimes = samples
    .filter((s) => s.checkpointInFlight === true)
    .map((s) => Date.parse(s.t));
  const cpFrom = inFlightTimes.length ? Math.min(...inFlightTimes) : liveAtMs;
  const cpTo = inFlightTimes.length ? Math.max(...inFlightTimes) + 2_000 : liveAtMs;
  const cpGap = statusGap(samples, cpFrom, cpTo);
  const gap = statusGap(samples, liveAtMs, windowEndMs);
  const alone = statusGap(samples, liveAtMs, windowEndMs, 1);
  detail.postLiveWindowSeconds = +((windowEndMs - liveAtMs) / 1000).toFixed(1);
  // the ASSERTED one
  detail.checkpointWindowSeconds = +((cpTo - cpFrom) / 1000).toFixed(1);
  detail.maxStatusWaitDuringCheckpointMs = cpGap.waitedMs;
  detail.maxStatusWaitDuringCheckpointAt = cpGap.waitedAt;
  detail.maxBetweenAnswersDuringCheckpointMs = cpGap.betweenMs;
  // context, recorded and not asserted
  detail.maxStatusWaitPostLiveMs = gap.waitedMs;
  detail.maxStatusWaitPostLiveAt = gap.waitedAt;
  detail.maxBetweenAnswersPostLiveMs = gap.betweenMs;
  detail.maxStatusIdlePostLiveMs = gap.idleMs;
  // the daemon alone on the core — no second node process in the sample
  detail.maxStatusWaitAloneMs = alone.waitedMs;
  detail.maxStatusWaitAloneAt = alone.waitedAt;
  detail.samplesWithAnotherNodeProc = samples.filter(
    (s) => Date.parse(s.t) > liveAtMs && (s.procs?.length ?? 1) > 1
  ).length;
  detail.statusSamplesPostLive = samples.filter((s) => Date.parse(s.t) > liveAtMs).length;
  detail.statusFailuresPostLive = samples.filter(
    (s) => !s.ok && Date.parse(s.t) > liveAtMs
  ).length;

  checks.checkpointObserved = sawInFlight && sawFinished;
  checks.statusAnsweredThroughCheckpoint = cpGap.waitedMs < MAX_STATUS_GAP_MS;
  // and the daemon's own worst case, with nothing else on the core, has to
  // clear the same bound — otherwise a quiet box would be the only place
  // the claim held
  checks.statusAnsweredWhenAlone = alone.waitedMs < MAX_STATUS_GAP_MS;
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
  detail.checkpointLineCount = offThread.length;
  detail.checkpointReport = inspectAfter(logs.split('\n'), 'checkpoint written off-thread');
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
    maxStatusWaitMs: MAX_STATUS_GAP_MS,
    maxStatusWaitScope: 'the checkpoint window, and the daemon alone on the core',
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
  maxStatusWaitDuringCheckpointMs: detail.maxStatusWaitDuringCheckpointMs,
  maxStatusWaitAloneMs: detail.maxStatusWaitAloneMs,
  maxStatusWaitPostLiveMs: detail.maxStatusWaitPostLiveMs,
  peakDuringCheckpointGiB: detail.peakDuringCheckpointGiB,
  microsecondsPerValueRow: (detail.loadProfile as Record<string, unknown> | null)?.microsecondsPerValueRow,
  chunkTimeoutRetries: detail.chunkTimeoutRetries,
});
process.exit(0);
