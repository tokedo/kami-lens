// Gate G2.c [live] — clock-skew immunity. Two daemon runs — one with the
// system clock deliberately skewed ±120 s (container prerequisite, arranged
// operationally; e.g. docker run with libfaketime "-120" / "+120"), one
// unskewed — dump projections at the SAME target stream position, and the
// dumps must agree: the skew must be visible in the wall clocks but absent
// from the corrected clock and the projected values (DESIGN §3.8,
// PORT_PLAN G2.c).
//
// Usage:
//   dump:    tsx c-clock-skew.mts dump <out.json> <targetBlock>
//     Starts the daemon, reaches LIVE, streams until the live block passes
//     <targetBlock>, stops, heals the checkpoint to exactly <targetBlock>
//     via RPC replay, then computes the calc set for a deterministic kami
//     sample with the wall clock frozen at one instant and the §3.8 offset
//     as learned from the live stream. Records wallMs, offsetMs, nowMs.
//     Run this CONCURRENTLY in the skewed container and on the unskewed
//     host with the same <targetBlock> (a couple hundred blocks ahead), so
//     both dumps happen at (nearly) the same real instant.
//   compare: tsx c-clock-skew.mts compare <skewed.json> <unskewed.json>
//     Asserts: same block; wall clocks differ by ≥ 100 s (the skew was
//     real); corrected now() agrees within 5 s (the skew was corrected);
//     every projected value agrees within display rounding (±1 unit, the
//     runs dump within seconds of each other so time-dependent values may
//     straddle a unit boundary).
//
// The dump side never reads the container's wall clock into the verdict —
// wallMs is recorded precisely to prove the skew existed.

import { readFileSync, writeFileSync } from 'node:fs';

import * as clock from 'clock';
import { KamiLensDaemon } from '../../src/daemon';
import { resolveConfig } from '../../src/config';
import { getKami } from '../../src/network/shapes/Kami';
import { query as queryKamis } from '../../src/network/shapes/Kami/queries';
import * as calcsBase from '../../src/app/cache/kami/calcs/base';
import * as calcsKamiHarvest from '../../src/app/cache/kami/calcs/harvest';
import {
  ARTIFACTS_DIR,
  cloneStateCache,
  fail,
  loadCacheFromSnapshotFile,
  makeFetchWorldEvents,
  makeProvider,
  pass,
  replayOnto,
  sleep,
  snapshotFilePath,
  writeMeasurement,
} from '../g1/lib.mts';
import { buildMirror } from './lib.mts';
import path from 'node:path';

const KAMI_OPTS = {
  bonus: true,
  config: true,
  flags: true,
  harvest: true,
  progress: true,
  rerolls: true,
  skills: true,
  stats: true,
  time: true,
  traits: true,
};

type DumpRow = { index: number; state: string; hp: number; musu: number; cooldownSec: number };
type Dump = {
  targetBlock: number;
  wallMs: number;
  offsetMs: number;
  nowMs: number;
  rows: DumpRow[];
};

const [mode, ...args] = process.argv.slice(2);

if (mode === 'dump') {
  const [outPath, targetBlockArg] = args;
  const targetBlock = Number(targetBlockArg);
  if (!outPath || !Number.isFinite(targetBlock)) {
    console.error('usage: c-clock-skew.mts dump <out.json> <targetBlock>');
    process.exit(2);
  }

  const config = resolveConfig();
  const dataDir = path.join(ARTIFACTS_DIR, 'g2c-data');
  const daemon = new KamiLensDaemon({ dataDir, checkpointIntervalMs: 600_000 });
  await daemon.start();
  console.log('[g2.c] daemon LIVE; waiting for live block ≥', targetBlock);
  for (;;) {
    const status = daemon.getStatus();
    if ((status.liveBlockNumber ?? 0) >= targetBlock) break;
    await sleep(1000);
  }
  await daemon.stop();

  const wallMs = Date.now();
  const offsetMs = clock.offset();
  const nowMs = clock.now();
  if (clock.lastObservedAtWallMs() === 0) {
    fail('G2.c-dump', { reason: 'clock never observed a stream blockTimestamp' });
  }

  const snapPath = snapshotFilePath({ ...config, dataDir });
  const cache = await loadCacheFromSnapshotFile(snapPath, config);
  const healed = cloneStateCache(cache);
  const provider = makeProvider(config);
  await replayOnto(healed, makeFetchWorldEvents(provider, config), targetBlock);
  provider.destroy();

  const { world, components } = buildMirror(healed);
  const entities = queryKamis(components);
  const realNow = Date.now;
  Date.now = () => wallMs; // freeze the wall; offset stays as learned
  const rows: DumpRow[] = [];
  try {
    for (const e of entities) {
      const kami = getKami(world, components, e, KAMI_OPTS);
      if ((kami.index ?? 0) % 17 !== 0) continue; // deterministic ~6% sample
      rows.push({
        index: kami.index,
        state: kami.state,
        hp: Math.round(calcsBase.calcHealth(kami)),
        musu: Math.floor(calcsKamiHarvest.calcOutput(kami)),
        cooldownSec: Math.round(calcsBase.calcCooldown(kami)),
      });
    }
  } finally {
    Date.now = realNow;
  }
  rows.sort((a, b) => a.index - b.index);
  const dump: Dump = { targetBlock, wallMs, offsetMs, nowMs, rows };
  writeFileSync(outPath, JSON.stringify(dump, null, 2));
  console.log(`[g2.c] dumped ${rows.length} rows at block ${targetBlock} (offset ${offsetMs} ms)`);
  process.exit(0);
} else if (mode === 'compare') {
  const [skewedPath, unskewedPath] = args;
  if (!skewedPath || !unskewedPath) {
    console.error('usage: c-clock-skew.mts compare <skewed.json> <unskewed.json>');
    process.exit(2);
  }
  const skewed = JSON.parse(readFileSync(skewedPath, 'utf8')) as Dump;
  const unskewed = JSON.parse(readFileSync(unskewedPath, 'utf8')) as Dump;

  if (skewed.targetBlock !== unskewed.targetBlock) {
    fail('G2.c', {
      reason: 'dumps are at different stream positions',
      skewed: skewed.targetBlock,
      unskewed: unskewed.targetBlock,
    });
  }
  const wallDelta = Math.abs(skewed.wallMs - unskewed.wallMs);
  const nowDelta = Math.abs(skewed.nowMs - unskewed.nowMs);
  const skewWasReal = wallDelta >= 100_000;
  const skewCorrected = nowDelta <= 5_000;

  const byIndex = new Map(unskewed.rows.map((r) => [r.index, r]));
  let mismatches = 0;
  const samples: Record<string, unknown>[] = [];
  for (const row of skewed.rows) {
    const other = byIndex.get(row.index);
    if (!other) {
      mismatches++;
      continue;
    }
    const bad =
      row.state !== other.state ||
      Math.abs(row.hp - other.hp) > 1 ||
      Math.abs(row.musu - other.musu) > 1 ||
      Math.abs(row.cooldownSec - other.cooldownSec) > 1;
    if (bad) {
      mismatches++;
      if (samples.length < 10) samples.push({ skewed: row, unskewed: other });
    }
  }

  await writeMeasurement('g2c-clock-skew', {
    targetBlock: skewed.targetBlock,
    rows: skewed.rows.length,
    wallDeltaMs: wallDelta,
    nowDeltaMs: nowDelta,
    skewedOffsetMs: skewed.offsetMs,
    unskewedOffsetMs: unskewed.offsetMs,
    skewWasReal,
    skewCorrected,
    mismatches,
    mismatchSamples: samples,
    match: skewWasReal && skewCorrected && mismatches === 0 && skewed.rows.length > 0,
  });

  if (!skewWasReal) {
    fail('G2.c', { reason: 'wall clocks agree — the container skew was not in effect', wallDeltaMs: wallDelta });
  }
  if (!skewCorrected) {
    fail('G2.c', { reason: 'corrected clocks disagree — §3.8 offset correction failed', nowDeltaMs: nowDelta });
  }
  if (mismatches > 0 || skewed.rows.length === 0) {
    fail('G2.c', { reason: 'projection mismatch under skew', mismatches, samples });
  }
  pass('G2.c', {
    rows: skewed.rows.length,
    wallDeltaMs: wallDelta,
    nowDeltaMs: nowDelta,
    targetBlock: skewed.targetBlock,
  });
  process.exit(0);
} else {
  console.error('usage: c-clock-skew.mts dump|compare ...');
  process.exit(2);
}
