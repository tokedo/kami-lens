// Gate G1.d [live] — warm restart. Restarts the daemon on the data dir left
// by a-bootstrap.mts: the incremental resume must converge to the same
// canonical state hash as a parallel fresh bootstrap at a common block, and
// warm time-to-LIVE must beat the cold path. Hashes are computed over each
// daemon's final Kamigaze-consistent checkpoint, converged to a common
// block via RPC replay.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { KamiLensDaemon } from '../../src/daemon';
import { resolveConfig } from '../../src/config';
import {
  canonicalStateHash,
  fail,
  loadCacheFromSnapshotFile,
  makeFetchWorldEvents,
  makeProvider,
  pass,
  readArtifact,
  replayOnto,
  snapshotFilePath,
  writeMeasurement,
} from './lib.mts';

const LIVE_BUDGET_MS = 300_000;

const { timeToLiveColdMs, dataDir } = await readArtifact<{
  timeToLiveColdMs: number;
  dataDir: string;
}>('g1a-result.json');

async function runToLiveAndCheckpoint(dir: string): Promise<{ ms: number; snapshot: string }> {
  const daemon = new KamiLensDaemon({ dataDir: dir, checkpointIntervalMs: 3_600_000 });
  const t0 = Date.now();
  await daemon.start();
  const budget = setTimeout(() => {
    console.error('FAIL G1.d {"reason":"LIVE not reached within budget"}');
    process.exit(1);
  }, LIVE_BUDGET_MS);
  await daemon.live;
  clearTimeout(budget);
  const ms = Date.now() - t0;
  await daemon.stop(); // final checkpoint refresh
  return { ms, snapshot: snapshotFilePath(resolveConfig({ dataDir: dir })) };
}

// Warm restart on the dir a-bootstrap left behind.
console.log('[g1.d] warm restart…');
const warm = await runToLiveAndCheckpoint(dataDir);
const warmMs = warm.ms;

// Parallel fresh bootstrap (fresh temp dir).
console.log('[g1.d] fresh cold bootstrap…');
const coldDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kami-lens-g1d-'));
const cold = await runToLiveAndCheckpoint(coldDir);
const coldMs = cold.ms;

// Converge both checkpoints to a common block and compare canonical hashes.
const config = resolveConfig();
const warmMirror = await loadCacheFromSnapshotFile(warm.snapshot, resolveConfig({ dataDir }));
const coldMirror = await loadCacheFromSnapshotFile(cold.snapshot, resolveConfig({ dataDir: coldDir }));
await fs.rm(coldDir, { recursive: true, force: true });

const provider = makeProvider(config);
const fetchWorldEvents = makeFetchWorldEvents(provider, config);
const q = Math.max(warmMirror.blockNumber, coldMirror.blockNumber) + 2;
console.log(`[g1.d] converging both mirrors to block ${q}`);
await replayOnto(warmMirror, fetchWorldEvents, q);
await replayOnto(coldMirror, fetchWorldEvents, q);
const hWarm = canonicalStateHash(warmMirror);
const hCold = canonicalStateHash(coldMirror);

await writeMeasurement('g1d-restart', {
  timeToLiveWarmMs: warmMs,
  timeToLiveColdMs_reference: timeToLiveColdMs,
  timeToLiveColdMs_parallel: coldMs,
  commonBlock: q,
  warmHash: hWarm,
  coldHash: hCold,
  match: hWarm.hash === hCold.hash,
});

if (hWarm.hash !== hCold.hash) {
  fail('G1.d', { reason: 'warm and cold mirrors diverge', warm: hWarm, cold: hCold });
}
if (!(warmMs < timeToLiveColdMs && warmMs < coldMs)) {
  fail('G1.d', {
    reason: 'warm restart did not beat cold time-to-LIVE',
    warmMs,
    coldReferenceMs: timeToLiveColdMs,
    coldParallelMs: coldMs,
  });
}
pass('G1.d', {
  warmMs,
  coldReferenceMs: timeToLiveColdMs,
  coldParallelMs: coldMs,
  commonBlock: q,
  hash: hWarm.hash,
  entries: hWarm.entries,
});
provider.destroy();
process.exit(0);
