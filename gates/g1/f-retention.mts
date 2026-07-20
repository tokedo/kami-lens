// Gate G1.f — retention re-measure [live]. Re-runs the log-retention
// bisection from the design phase (~1.02 M blocks ≈ 25 days as of
// 2026-07-20): finds the oldest block whose World logs the public RPC still
// serves, records horizon + head + date to docs/measurements/, asserts a
// sane floor (> 100 k blocks), and flags DESIGN §4.1 for update if the
// value drifted > 20 % from the recorded 1.02 M.
//
// Probe: a 2 000-block getLogs span. World log density is ~15–17 logs/block
// recently and the world has never been quiet for thousands of blocks, so
// an empty span means pruned, not idle. Pruned ranges return empty HTTP-200
// results — that asymmetry is exactly what is being measured.

import { resolveConfig } from '../../src/config';
import { fail, makeProvider, pass, sleep, writeMeasurement } from './lib.mts';

const DESIGN_RETENTION_BLOCKS = 1_020_000; // DESIGN §4.1, measured 2026-07-20
const PROBE_SPAN = 2_000;
const PROBE_PAUSE_MS = 250;

const config = resolveConfig();
const provider = makeProvider(config);

async function probeHasLogs(fromBlock: number): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const logs = await provider.getLogs({
        address: config.worldAddress,
        fromBlock,
        toBlock: fromBlock + PROBE_SPAN,
      });
      return logs.length > 0;
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
  return false;
}

const head = await provider.getBlockNumber();

// Bisect the oldest block with servable logs in [initialBlockNumber, head].
let lo = config.initialBlockNumber; // logs known-missing here on the pruned public RPC
let hi = head - PROBE_SPAN - 1; // logs known-present near head
if (!(await probeHasLogs(hi))) fail('G1.f', { reason: 'no logs near head — probe broken?', head });
if (await probeHasLogs(lo)) {
  // Unpruned RPC (dev chain / archive): horizon is the deploy block.
  const file = await writeMeasurement('g1f-retention', {
    head,
    horizon: lo,
    retentionBlocks: head - lo,
    note: 'RPC serves the full world span (archive/dev) — no pruning observed',
  });
  pass('G1.f', { head, horizon: lo, file });
  process.exit(0);
}

let probes = 2;
while (hi - lo > PROBE_SPAN) {
  const mid = Math.floor((lo + hi) / 2);
  await sleep(PROBE_PAUSE_MS);
  if (await probeHasLogs(mid)) hi = mid;
  else lo = mid;
  probes++;
}

const horizon = hi;
const retentionBlocks = head - horizon;
const approxDays = (retentionBlocks * 2.1) / 86_400;
const driftPct = ((retentionBlocks - DESIGN_RETENTION_BLOCKS) / DESIGN_RETENTION_BLOCKS) * 100;
const driftFlag = Math.abs(driftPct) > 20;

const file = await writeMeasurement('g1f-retention', {
  head,
  horizon,
  retentionBlocks,
  approxDays: Number(approxDays.toFixed(1)),
  probes,
  probeSpan: PROBE_SPAN,
  designValueBlocks: DESIGN_RETENTION_BLOCKS,
  driftPct: Number(driftPct.toFixed(1)),
  designUpdateFlagged: driftFlag,
});

if (retentionBlocks <= 100_000) {
  fail('G1.f', { reason: 'retention floor violated', retentionBlocks, file });
}
if (driftFlag) {
  console.warn(
    `G1.f NOTE: retention drifted ${driftPct.toFixed(1)}% vs DESIGN §4.1 — update the design table`
  );
}
pass('G1.f', { head, horizon, retentionBlocks, approxDays: approxDays.toFixed(1), driftPct: driftPct.toFixed(1), file });
provider.destroy();
process.exit(0);
