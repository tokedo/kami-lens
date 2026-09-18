// Gate G10.a + G10.b [live] — CDN cold boot, and parity of what it loaded.
//
// G10.a: a daemon on a FRESH data dir with the DEFAULT config (which since
// 0.6.2 means the state CDN is on) must reach LIVE, and its log must say the
// full load was served by the CDN, naming the export prefix. Records the
// cold→LIVE wall time, the `[cdn] load profile` numbers, the longest
// progress-silent interval (divergence 10 — the pre-LIVE stall watchdog sees
// only what setLoadingState emits, and PRELIVE_STALL_MS is 90 s), peak RSS,
// and the bridge path taken with the delta's block span. Since divergence 12
// the bridge is DELTA-FIRST, so "which path" is no longer "did the delta run"
// (it always does) but "did it SUCCEED": delta-ok means the gap-fill covered
// only the snapshot service's sync period, delta-failed means it log-scanned
// the whole window from the chain.
//
// G10.b: the load is only worth anything if what it loaded is RIGHT. Three
// checks against THIS daemon, while it is still LIVE on its own socket:
//   1. the mirror is not known-incomplete — `sync.unhealedRanges` empty and
//      `sync.reconciledThrough` at or past the stream's start block. The
//      bridge closes the same window fillGap does (divergence 9), so a
//      baseline that never got seeded is a bridge that never ran.
//   2. the lab drift probe over 50 SETTLED facts against the oracle's
//      independent read of the chain → zero divergences. This is the check
//      that would have caught L-1 (2026-09-06: seven kamis served
//      HARVESTING for 3.5 h after the chain stopped them, with the daemon
//      LIVE and `degraded: []` throughout).
//   3. G3.b's node-occupancy cross-check, re-run against the state THIS
//      boot loaded: every ACTIVE harvest on a busy node verified by pinned
//      eth_call reads. Run as a subprocess against a checkpoint of this
//      daemon (G3B_SNAPSHOT), not against the shared c2 fixture — the point
//      is to chain-verify the CDN-loaded image, not the one G3 already has.
// Then the state counts are compared with the local PRODUCTION daemon's
// newest checkpoint line: components must be EQUAL (the registry does not
// grow between two live daemons), entities and values only within the block
// delta's growth.
//
// The drift probe is the lab's (kami-lab provisioning/local-lens), and it is
// a TEMPLATE: install.sh substitutes __NODE__ and __LENS_DIR__, and it has no
// socket or data-dir knob at all — it talks to whatever daemon this repo's
// dist/cli.js resolves by default, which is the PRODUCTION one. So this gate
// makes its own substituted copy in the data dir and injects `--data-dir`
// into the probe's single CLI helper, asserting each substitution landed
// rather than hoping. Recorded as a finding: the probe wants that knob.
//
// The oracle token is read by the probe itself from ~/.blocklife-keys/.env at
// call time. It is never passed on a command line, never written to a
// measurement, and never printed (kami-lab hard rule 4).
//
// NEVER TOUCHES THE LIVE DAEMONS. This leg starts one daemon of its own on
// G10_DATA_DIR (see gates/g10/lib.mts), reads the production daemon's log
// read-only, and signals nothing.

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { resolveConfig } from '../../src/config';
import { KamiLensDaemon } from '../../src/daemon';
import { socketPath, startQuerySocket } from '../../src/server';
import { fail, pass, REPO_ROOT, snapshotFilePath, writeMeasurement } from '../g1/lib.mts';
import {
  bootAndWatch,
  fullLoadLine,
  G10_DATA_DIR,
  linesMatching,
  loadProfile,
  PROD_LOG,
  tapConsole,
} from './lib.mts';

const LIVE_BUDGET_MS = 600_000;
/** the bound this measurement exists to be compared against (daemon.ts) */
const PRELIVE_STALL_MS = 90_000;
/** the brief's own threshold: a silence past this on a 10-core Mac is a
 * warning about the 2-vCPU VM, whose decode throughput is about half */
const SILENCE_CONCERN_MS = 60_000;
const DRIFT_PROBE = path.join(
  process.env.HOME ?? '',
  'kami-lab',
  'provisioning',
  'local-lens',
  'drift_probe.py'
);

await fs.rm(G10_DATA_DIR, { recursive: true, force: true });
await fs.mkdir(G10_DATA_DIR, { recursive: true });

const config = resolveConfig({ dataDir: G10_DATA_DIR, checkpointIntervalMs: 3_600_000 });
if (!config.stateCdnUrl) {
  fail('G10.a', {
    reason: 'the default config has no stateCdnUrl — this leg proves the DEFAULT cold boot',
  });
}
console.log(`[g10.a] data dir ${G10_DATA_DIR}`);
console.log(`[g10.a] state CDN ${config.stateCdnUrl}`);

// --------------------------------------------------------------- G10.a

const tap = tapConsole();
const daemon = new KamiLensDaemon({ dataDir: G10_DATA_DIR, checkpointIntervalMs: 3_600_000 });
let watch: Awaited<ReturnType<typeof bootAndWatch>>;
try {
  watch = await bootAndWatch(daemon, { budgetMs: LIVE_BUDGET_MS });
} catch (e) {
  tap.stop();
  await writeMeasurement('g10a-cdn-cold-boot', {
    outcome: 'FAILED',
    reason: e instanceof Error ? e.message : String(e),
    cdnUrl: config.stateCdnUrl,
    fullLoad: fullLoadLine(tap.lines),
    cdnLines: linesMatching(tap.lines, '[cdn]'),
  });
  fail('G10.a', { reason: e instanceof Error ? e.message : String(e) });
}
tap.stop();

const atLive = daemon.getStatus();
const served = fullLoadLine(tap.lines);
const profile = loadProfile(tap.lines);
const cdnLines = linesMatching(tap.lines, '[cdn]');
const bridgeLines = linesMatching(tap.lines, '[bridge]');
const gapfillLines = linesMatching(tap.lines, '[gapfill]');
// `Stored block <n>` (state/cache.ts storeBlock) is printed once per cache
// stamp, so on the delta-first bridge it should be exactly TWO: the CDN load
// and the delta. Recorded as a cross-check on the bridge lines rather than as
// the signal itself — since divergence 12 the delta is unconditional, so a
// count of one means the delta THREW before it stamped anything.
const storedBlocks = linesMatching(tap.lines, 'Stored block').length;
const deltaApplied = bridgeLines.find((l) => l.includes('snapshot delta applied'));
const deltaFailed = bridgeLines.some((l) => l.includes('snapshot delta FAILED'));
/** the delta's own {from, to, blocks} payload — the span the CDN image was
 * carried over before the gap-fill took the rest */
const deltaSpan = ((): Record<string, unknown> | null => {
  if (!deltaApplied) return null;
  const brace = deltaApplied.indexOf('{');
  if (brace < 0) return null;
  try {
    return JSON.parse(deltaApplied.slice(brace)) as Record<string, unknown>;
  } catch {
    return null;
  }
})();
const bridgePath =
  bridgeLines.length === 0
    ? 'no-bridge (fillGap ran — the CDN load did not happen, or there is no stream URL)'
    : deltaFailed
      ? 'delta FAILED — gap-filled the full window from the chain with RPC on'
      : deltaApplied
        ? 'delta-first: delta applied, then gap-filled from the delta head'
        : 'bridge entered but neither outcome logged — READ THE LINES, do not trust this field';

const record = {
  outcome: 'LIVE',
  cdnUrl: config.stateCdnUrl,
  timeToLiveMs: watch.timeToLiveMs,
  servedBy: served?.detail.source ? (served.line.includes('by CDN') ? 'cdn' : 'grpc') : 'unknown',
  servedLine: served?.line ?? null,
  prefix: served?.detail.prefix ?? null,
  loadProfile: profile,
  lastFullLoad: atLive.lastFullLoad,
  progress: {
    // the TRUE maximum, whatever its size — `longestSilentMs` only reports
    // intervals over the 10 s threshold and reads 0 when none was
    maxSilenceMs: watch.maxSilenceMs,
    longestSilentMs: watch.longestSilentMs,
    longestSilentOn: watch.longestSilentOn,
    preLiveStallBoundMs: PRELIVE_STALL_MS,
    headroomMs: PRELIVE_STALL_MS - watch.maxSilenceMs,
    concernThresholdMs: SILENCE_CONCERN_MS,
    overConcernThreshold: watch.maxSilenceMs > SILENCE_CONCERN_MS,
    silences: watch.silences,
    samples: watch.progressSamples,
  },
  memory: { peakRssKb: watch.peakRssKb, peakHeapRssKb: watch.peakHeapRssKb, samples: watch.rssSamples },
  bridgePath,
  deltaSpan,
  bridgeLines,
  gapfillLines,
  storedBlocks,
  cdnLines,
  checkpoint: atLive.checkpoint,
  sync: atLive.sync,
  degraded: atLive.degraded,
  tripwires: atLive.tripwires,
};

if (!served || !served.line.includes('by CDN')) {
  await writeMeasurement('g10a-cdn-cold-boot', { ...record, outcome: 'WRONG-SOURCE' });
  fail('G10.a', { reason: 'the full load was not served by the CDN', servedLine: served?.line ?? null });
}
if (!record.prefix) {
  await writeMeasurement('g10a-cdn-cold-boot', { ...record, outcome: 'NO-PREFIX' });
  fail('G10.a', { reason: 'the CDN load named no export prefix — which image was loaded is unknowable' });
}
await writeMeasurement('g10a-cdn-cold-boot', record);
// The bridge must have been ENTERED. A CDN load that reached LIVE through
// fillGap instead means divergence 11's gate or divergence 12's wiring is not
// doing what the banner says, and that is a silent correctness question, not a
// cosmetic one.
if (bridgeLines.length === 0) {
  await writeMeasurement('g10a-cdn-cold-boot', { ...record, outcome: 'NO-BRIDGE' });
  fail('G10.a', {
    reason: 'the CDN load did not go through bridgeBoot — fillGap closed the window instead',
    bridgePath,
  });
}
pass('G10.a', {
  timeToLiveMs: watch.timeToLiveMs,
  prefix: record.prefix,
  maxSilenceMs: watch.maxSilenceMs,
  longestSilentMs: watch.longestSilentMs,
  peakRssKb: watch.peakRssKb,
  bridgePath,
  deltaSpan,
});
if (watch.maxSilenceMs > SILENCE_CONCERN_MS) {
  console.warn(
    `[g10.a] NOTE: longest progress silence ${watch.maxSilenceMs}ms exceeds ` +
      `${SILENCE_CONCERN_MS}ms on this machine. The VM has 2 vCPU and roughly half ` +
      `the decode throughput, so it is the one PRELIVE_STALL_MS (${PRELIVE_STALL_MS}ms) ` +
      `would trip on. Reported, not fixed here.`
  );
}

// --------------------------------------------------------------- G10.b

const bChecks: Record<string, boolean> = {};
const bDetail: Record<string, unknown> = {};

// 1. the mirror is not known-incomplete, and the reconcile baseline is seeded
const sync = atLive.sync;
bChecks.noUnhealedRanges = sync.unhealedRanges.length === 0;
bChecks.reconcileBaselineSeeded = sync.reconciledThrough !== null;
bChecks.reconciledThroughAtOrPastLoad =
  sync.reconciledThrough !== null && sync.reconciledThrough >= (atLive.lastFullLoad?.block ?? 0);
bDetail.sync = sync;
bDetail.lastFullLoad = atLive.lastFullLoad;

// the socket the probe will talk to
const server = startQuerySocket(daemon, G10_DATA_DIR);
console.log(`[g10.b] socket ${socketPath(G10_DATA_DIR)}`);

// 2. the lab drift probe, against THIS socket
//
// The repo copy is a template with no data-dir knob, so make a substituted
// copy and inject one. Every substitution is asserted: a probe that silently
// kept talking to the production daemon would "pass" this gate while proving
// nothing about the CDN-loaded state, which is the one outcome that must be
// impossible here.
//
// ITS TIME BUDGETS ARE ALSO RAISED, IN THE COPY ONLY, and the first run is why.
// The probe drives the lens through `node dist/cli.js`, one fresh process per
// call, ~51 calls. Measured on this box while a gate process held a 4.25 GB
// heap: 1.1-3.2 s per cold call, dominated by Node start plus loading the
// 1.5 MB bundle. Against the template's LENS_TIMEOUT of 10 s the FIRST call
// (`status`) timed out, and even without that, 51 calls at ~1.5 s cannot fit
// the template's 45 s SELF_TIMEOUT_S. Those numbers are right for the
// production watchdog — a quiet box, and a self-bound that must not wedge it —
// and wrong for a gate that runs the probe beside a multi-GB cold boot. So the
// copy gets room and the gate's own execFileSync timeout does the bounding
// instead. The TEMPLATE IN kami-lab IS NOT TOUCHED. Recorded as a finding: the
// knob the probe wants is not just --data-dir but configurable budgets.
//
// A warm-up `status` round trip goes first, from the gate itself over the
// socket, so the probe's first call is not also paying for a cold page cache.
let drift: Record<string, unknown> = { skipped: 'probe not found', path: DRIFT_PROBE };
try {
  const template = await fs.readFile(DRIFT_PROBE, 'utf8');
  let probe = template
    .split('__NODE__')
    .join(process.execPath)
    .split('__LENS_DIR__')
    .join(REPO_ROOT)
    .split('__HOME__')
    .join(process.env.HOME ?? '');
  const callSite = '[NODE, CLI] + args,';
  if (!probe.includes(callSite)) {
    throw new Error(
      `the drift probe's CLI call site moved — expected ${JSON.stringify(callSite)}. ` +
        `Re-read provisioning/local-lens/drift_probe.py before trusting this leg.`
    );
  }
  probe = probe
    .split(callSite)
    .join(`[NODE, CLI] + args + ["--data-dir", ${JSON.stringify(G10_DATA_DIR)}],`);
  if (probe.includes('__NODE__') || probe.includes('__LENS_DIR__')) {
    throw new Error('a drift-probe placeholder was left unsubstituted');
  }
  // budgets, in the copy only — asserted like every other substitution
  const budgets: [string, string][] = [
    ['LENS_TIMEOUT = 10', 'LENS_TIMEOUT = 40'],
    ['SELF_TIMEOUT_S = 45', 'SELF_TIMEOUT_S = 420'],
  ];
  for (const [before, after] of budgets) {
    if (!probe.includes(before)) {
      throw new Error(
        `the drift probe's budget line moved — expected ${JSON.stringify(before)}. ` +
          `Re-read provisioning/local-lens/drift_probe.py before trusting this leg.`
      );
    }
    probe = probe.split(before).join(after);
  }
  const probePath = path.join(G10_DATA_DIR, 'drift_probe.g10.py');
  await fs.writeFile(probePath, probe, { mode: 0o755 });
  // warm the CLI bundle and the daemon's head-sample provider, so the probe's
  // first call is not the one paying for a cold start (see the note above)
  try {
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'dist', 'cli.js'), 'status', '--data-dir', G10_DATA_DIR], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    /* the probe reports an unreachable lens itself, and more usefully */
  }
  // read the exit code, not the output alone — 2 is a SKIP, not a pass. The
  // gate's bound is deliberately above the copy's raised SELF_TIMEOUT_S.
  const out = execFileSync('python3', [probePath], { encoding: 'utf8', timeout: 600_000 });
  drift = JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? '{}') as Record<string, unknown>;
  drift.exitCode = 0;
} catch (e) {
  const err = e as { status?: number; stdout?: string; message?: string };
  const line = (err.stdout ?? '').trim().split('\n').filter(Boolean).pop();
  drift = {
    exitCode: err.status ?? null,
    error: err.message,
    ...(line ? (JSON.parse(line) as Record<string, unknown>) : {}),
  };
}
bDetail.drift = drift;
// 0 divergences on a probe that actually RAN. A skip (exit 2) is not a pass:
// the whole point of this leg is that the comparison happened.
bChecks.driftProbeRan = drift.exitCode === 0 && !drift.skipped;
bChecks.driftZeroDivergences = drift.divergent === 0;
// 50 is the target (25 harvesting + 25 not). The probe conservatively DROPS a
// kami whose settle clock refreshed, so a run can come back a little short and
// still be a real comparison; a run that came back with a handful is not.
bChecks.driftSampledEnough = typeof drift.sampled === 'number' && drift.sampled >= 40;
bDetail.driftSampled = drift.sampled ?? null;
bDetail.driftSampleTarget = 50;

// 3. G3.b's occupancy cross-check against a checkpoint of THIS daemon
const cp = await daemon.checkpoint();
const g10Snapshot = path.join(G10_DATA_DIR, 'g10-cdn.v8snap');
await fs.copyFile(snapshotFilePath(config), g10Snapshot);
console.log(`[g10.b] checkpoint at block ${cp.blockNumber} copied for the G3.b cross-check`);
let occupancy: Record<string, unknown>;
try {
  const out = execFileSync(
    'npx',
    ['tsx', '--tsconfig', 'tsconfig.json', 'gates/g3/b-node-occupancy.mts'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, G3B_SNAPSHOT: g10Snapshot },
      timeout: 1_800_000,
    }
  );
  occupancy = { exitCode: 0, tail: out.trim().split('\n').slice(-3) };
} catch (e) {
  const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
  occupancy = {
    exitCode: err.status ?? null,
    error: err.message,
    tail: (err.stdout ?? '').trim().split('\n').slice(-5),
    stderrTail: (err.stderr ?? '').trim().split('\n').slice(-5),
  };
}
bDetail.occupancy = occupancy;
bChecks.occupancyVerified = occupancy.exitCode === 0;

// 4. counts vs the local PRODUCTION daemon's newest checkpoint line
let prod: Record<string, unknown> = { skipped: 'no production log', path: PROD_LOG };
try {
  // TAIL ONLY. runDaemon prints one JSON line per status transition and the
  // production log is already 20 MB and growing, so reading it whole to find
  // the newest checkpoint would get slower every week for no gain. The last
  // few thousand lines cover hours of a daemon checkpointing every ten
  // minutes; if none of them carries a checkpoint that IS the finding, and it
  // is reported rather than papered over by reading further back.
  const PROD_LOG_TAIL_LINES = 4000;
  const whole = await fs.readFile(PROD_LOG, 'utf8');
  const log = whole.split('\n').slice(-PROD_LOG_TAIL_LINES).join('\n');
  const newest = log
    .split('\n')
    .reverse()
    .map((l) => {
      try {
        return JSON.parse(l) as { checkpoint?: Record<string, number> };
      } catch {
        return null;
      }
    })
    .find((o) => o?.checkpoint?.blockNumber);
  if (!newest?.checkpoint) throw new Error('no checkpoint line in the production log');
  prod = { checkpoint: newest.checkpoint };
  const p = newest.checkpoint;
  const blockDelta = cp.blockNumber - p.blockNumber;
  // components are a registry: two live daemons at any two blocks hold the
  // same set, so this one is EQUALITY and not a tolerance.
  const componentsEqual = cp.numComponents === p.numComponents;
  // entities and values only ever grow, and only by what happened in the
  // block delta. A NEGATIVE delta on the older side is the real signal.
  const entitiesOrdered = blockDelta >= 0 ? cp.numEntities >= p.numEntities : cp.numEntities <= p.numEntities;
  const valuesOrdered = blockDelta >= 0 ? cp.stateEntries >= p.stateEntries : cp.stateEntries <= p.stateEntries;
  prod = {
    ...prod,
    blockDelta,
    cdn: {
      block: cp.blockNumber,
      components: cp.numComponents,
      entities: cp.numEntities,
      values: cp.stateEntries,
    },
    production: {
      block: p.blockNumber,
      components: p.numComponents,
      entities: p.numEntities,
      values: p.stateEntries,
    },
    componentsEqual,
    entitiesOrdered,
    valuesOrdered,
  };
  bChecks.componentsMatchProduction = componentsEqual;
  bChecks.entitiesAndValuesOrdered = entitiesOrdered && valuesOrdered;
} catch (e) {
  prod = { ...prod, error: e instanceof Error ? e.message : String(e) };
  // a missing production log is a missing COMPARISON, not a failure of the
  // CDN load — recorded and named, and it does not gate.
}
bDetail.production = prod;

server.close();
await daemon.stop();

const bMatch = Object.values(bChecks).every(Boolean);
await writeMeasurement('g10b-cdn-parity', { checks: bChecks, ...bDetail, match: bMatch });
if (!bMatch) fail('G10.b', { checks: bChecks, detail: bDetail });
pass('G10.b', {
  driftSampled: bDetail.driftSampled,
  reconciledThrough: sync.reconciledThrough,
  components: (prod.cdn as { components?: number } | undefined)?.components ?? null,
});
process.exit(0);
