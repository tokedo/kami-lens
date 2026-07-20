// Gate G1.c [live] — replay cross-validation. Takes the two checkpoints
// produced by a-bootstrap.mts (C1 at block B1, C2 at block B2, spanning
// live Kamigaze streaming), RPC-replays ComponentValueSet/Removed events
// from C1 to a common quiet block Q slightly past B2, heals C2's own
// boundary to Q the same way, and requires the canonical state hashes to
// match exactly. This is the proof that the event decoder and the snapshot
// decoder agree.
//
// The plan's target span is N ≈ 20 000 blocks; the span actually replayed
// is recorded in the measurement (a shorter span is a provisional result,
// not a redefinition of the gate).

import { resolveConfig } from '../../src/config';
import {
  ARTIFACTS_DIR,
  canonicalStateHash,
  fail,
  loadCacheFromSnapshotFile,
  makeFetchWorldEvents,
  makeProvider,
  pass,
  readArtifact,
  writeMeasurement,
} from './lib.mts';
import path from 'node:path';

const { c1Block, c2Block } = await readArtifact<{ c1Block: number; c2Block: number }>(
  'g1a-result.json'
);

const config = resolveConfig();
const c1 = await loadCacheFromSnapshotFile(path.join(ARTIFACTS_DIR, 'c1.v8snap'), config);
const c2 = await loadCacheFromSnapshotFile(path.join(ARTIFACTS_DIR, 'c2.v8snap'), config);

const provider = makeProvider(config);
const fetchWorldEvents = makeFetchWorldEvents(provider, config);

const q = Math.max(c1.blockNumber, c2.blockNumber) + 2;
const span = q - c1.blockNumber;
console.log(`[g1.c] replaying C1 ${c1.blockNumber} → ${q} (${span} blocks) via RPC`);
const t0 = Date.now();
const { replayOnto } = await import('./lib.mts');
await replayOnto(c1, fetchWorldEvents, q);
const replayMs = Date.now() - t0;
console.log(`[g1.c] healing C2 ${c2.blockNumber} → ${q}`);
await replayOnto(c2, fetchWorldEvents, q);

const h1 = canonicalStateHash(c1);
const h2 = canonicalStateHash(c2);

await writeMeasurement('g1c-replay', {
  c1Block,
  c2Block,
  commonBlock: q,
  replaySpanBlocks: span,
  planTargetSpanBlocks: 20_000,
  provisional: span < 20_000,
  replayMs,
  rpcPathHash: h1,
  kamigazePathHash: h2,
  match: h1.hash === h2.hash,
});

if (h1.hash !== h2.hash) {
  fail('G1.c', {
    reason: 'state hash mismatch between RPC-replay and Kamigaze paths',
    rpc: h1,
    kamigaze: h2,
  });
}
pass('G1.c', {
  span,
  commonBlock: q,
  hash: h1.hash,
  entries: h1.entries,
  provisional: span < 20_000,
});
provider.destroy();
process.exit(0);
