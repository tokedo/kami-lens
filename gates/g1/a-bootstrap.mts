// Gate G1.a + G1.b [live] — bootstrap and mirror parity.
//
// G1.a: the daemon must reach LIVE from an empty cache within the time
// budget, with > 10⁵ mirror state entries.
//
// G1.b: ≥ 500 (component, entity) samples from the mirror — covering every
// component id present, Bare and full alike — compared against direct
// eth_call reads (has/getRawValue) pinned to the mirror's block, plus
// negative samples (pairs the mirror holds as absent must read absent
// on-chain). Zero mismatches allowed.
//
// Also produces the checkpoint artifacts for G1.c (c1/c2 snapshots spanning
// G1C_MIN_SPAN_BLOCKS of live streaming) and leaves the warm data dir for
// G1.d.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Contract } from 'ethers';

import { createDecode } from 'engine/encoders';
import { KamiLensDaemon } from '../../src/daemon';
import { resolveConfig } from '../../src/config';
import {
  ARTIFACTS_DIR,
  cloneStateCache,
  fail,
  makeFetchWorldEvents,
  makeProvider,
  pass,
  replayOnto,
  sleep,
  snapshotFilePath,
  writeArtifact,
  writeMeasurement,
} from './lib.mts';
import { packTuple, unpackTuple } from '@mud-classic/utils';

const LIVE_BUDGET_MS = 300_000;
const MIN_ENTRIES = 100_000;
const TARGET_SAMPLES = 500;
const NEGATIVE_SAMPLES = 50;
const CALL_SPACING_MS = 75;
const SPAN_TARGET_BLOCKS = Number(process.env.G1C_MIN_SPAN_BLOCKS ?? 600);
// hardcoded upstream (engine/encoders/decode.ts): world.component.components
const COMPONENTS_KEY = '0x4350dba81aa91e31664a09d24a668f006169a11b3d962b7557aed362d3252aec';

const dataDir = path.join(ARTIFACTS_DIR, 'g1-data');
await fs.rm(dataDir, { recursive: true, force: true });
await fs.mkdir(dataDir, { recursive: true });

const config = resolveConfig({ dataDir, checkpointIntervalMs: 3_600_000 });
const daemon = new KamiLensDaemon({ dataDir, checkpointIntervalMs: 3_600_000 });

// ---------------------------------------------------------------- G1.a

const t0 = Date.now();
await daemon.start();
const budget = setTimeout(() => {
  console.error(`FAIL G1.a {"reason":"LIVE not reached within ${LIVE_BUDGET_MS}ms"}`);
  process.exit(1);
}, LIVE_BUDGET_MS);
await daemon.live;
clearTimeout(budget);
const timeToLiveColdMs = Date.now() - t0;

const statusAtLive = daemon.getStatus();
if (statusAtLive.stateEntries <= MIN_ENTRIES) {
  fail('G1.a', { reason: 'too few mirror entries', entries: statusAtLive.stateEntries });
}
await writeMeasurement('g1a-bootstrap', {
  timeToLiveColdMs,
  blockNumber: statusAtLive.blockNumber,
  stateEntries: statusAtLive.stateEntries,
  numComponents: statusAtLive.numComponents,
  numEntities: statusAtLive.numEntities,
  tripwires: statusAtLive.tripwires,
});
pass('G1.a', {
  timeToLiveColdMs,
  entries: statusAtLive.stateEntries,
  blockNumber: statusAtLive.blockNumber,
});

// C1 checkpoint for G1.c
await daemon.checkpoint();
const c1Path = path.join(ARTIFACTS_DIR, 'c1.v8snap');
await fs.copyFile(snapshotFilePath(config), c1Path);
const c1Block = daemon.mirror.blockNumber;
console.log(`[g1] C1 checkpoint copied at block ${c1Block}`);

// ---------------------------------------------------------------- G1.b

// Freeze on a block transition so the newest block is one clean heal away.
const blockAtFreezeStart = daemon.mirror.blockNumber;
while (daemon.mirror.blockNumber === blockAtFreezeStart) await sleep(250);
const frozen = cloneStateCache(daemon.mirror);

const provider = makeProvider(config);
const fetchWorldEvents = makeFetchWorldEvents(provider, config);
const pinnedBlock = frozen.blockNumber + 1;
await replayOnto(frozen, fetchWorldEvents, pinnedBlock); // heal possible mid-block truncation

// Component registry: componentId (BigInt key) → contract address, from the
// mirror's own world.component.components rows.
const registryIdx = frozen.componentToIndex.get(COMPONENTS_KEY);
if (registryIdx === undefined) fail('G1.b', { reason: 'components registry missing from mirror' });
const addressByComponent = new Map<string, string>();
for (const [key, value] of frozen.state.entries()) {
  const [cIdx, eIdx] = unpackTuple(key);
  if (cIdx !== registryIdx) continue;
  const componentId = BigInt((value as { value: string }).value).toString(16);
  const address = '0x' + BigInt(frozen.entities[eIdx]!).toString(16).padStart(40, '0');
  addressByComponent.set(componentId, address);
}
console.log(`[g1] component registry: ${addressByComponent.size} addresses`);

// Bucket state keys by component index (skip the '0x0' primer at index 0).
const buckets = new Map<number, number[]>();
for (const key of frozen.state.keys()) {
  const [cIdx] = unpackTuple(key);
  if (cIdx === 0) continue;
  let bucket = buckets.get(cIdx);
  if (!bucket) buckets.set(cIdx, (bucket = []));
  bucket.push(key);
}

// Deterministic sampler (mulberry32) so runs are reproducible per pin+block.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(pinnedBlock);

const perComponent = Math.max(6, Math.ceil(TARGET_SAMPLES / buckets.size));
const positives: number[] = [];
const coverage: Record<string, number> = {};
for (const [cIdx, keys] of buckets.entries()) {
  const take = Math.min(perComponent, keys.length);
  const picked = new Set<number>();
  while (picked.size < take) picked.add(keys[Math.floor(rand() * keys.length)]!);
  positives.push(...picked);
  coverage[frozen.components[cIdx]!] = take;
}

// Negative samples: (component, entity) pairs the mirror holds as absent.
const componentIdxs = [...buckets.keys()];
const negatives: Array<[number, number]> = [];
let guard = 0;
while (negatives.length < NEGATIVE_SAMPLES && guard++ < 10_000) {
  const cIdx = componentIdxs[Math.floor(rand() * componentIdxs.length)]!;
  const eIdx = 1 + Math.floor(rand() * (frozen.entities.length - 1));
  if (!frozen.state.has(packTuple([cIdx, eIdx]))) negatives.push([cIdx, eIdx]);
}

const componentAbi = [
  'function has(uint256 entity) view returns (bool)',
  'function getRawValue(uint256 entity) view returns (bytes)',
];
const decode = createDecode();

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(typeof value === 'bigint' ? value.toString() : value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
    .join(',')}}`;
}

async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 2) throw e;
      await sleep(500 * 2 ** attempt);
    }
  }
}

function contractFor(cIdx: number): Contract {
  const componentId = BigInt(frozen.components[cIdx]!).toString(16);
  const address = addressByComponent.get(componentId);
  if (!address) throw new Error(`no registry address for component ${frozen.components[cIdx]}`);
  return new Contract(address, componentAbi, provider);
}

// Canary: verify pinned historical reads are available at all.
{
  const key = positives[0]!;
  const [cIdx, eIdx] = unpackTuple(key);
  await withRetries(() =>
    contractFor(cIdx).has(BigInt(frozen.entities[eIdx]!), { blockTag: pinnedBlock })
  );
}

const mismatches: Array<Record<string, unknown>> = [];
let checked = 0;
for (const key of positives) {
  const [cIdx, eIdx] = unpackTuple(key);
  const entityId = frozen.entities[eIdx]!;
  const componentId = frozen.components[cIdx]!;
  try {
    const raw: string = await withRetries(() =>
      contractFor(cIdx).getRawValue(BigInt(entityId), { blockTag: pinnedBlock })
    );
    const onChain = await decode(componentId, raw);
    const mirrorValue = frozen.state.get(key)!;
    if (stableJson(onChain) !== stableJson(mirrorValue)) {
      mismatches.push({ componentId, entityId, mirrorValue, onChain });
    }
  } catch (e) {
    mismatches.push({ componentId, entityId, error: String(e) });
  }
  checked++;
  if (checked % 100 === 0) console.log(`[g1.b] ${checked}/${positives.length} positive samples`);
  await sleep(CALL_SPACING_MS);
}

let negativeChecked = 0;
for (const [cIdx, eIdx] of negatives) {
  const entityId = frozen.entities[eIdx]!;
  const componentId = frozen.components[cIdx]!;
  try {
    const has: boolean = await withRetries(() =>
      contractFor(cIdx).has(BigInt(entityId), { blockTag: pinnedBlock })
    );
    if (has) mismatches.push({ componentId, entityId, reason: 'mirror absent but on-chain has=true' });
  } catch (e) {
    mismatches.push({ componentId, entityId, error: String(e) });
  }
  negativeChecked++;
  await sleep(CALL_SPACING_MS);
}

await writeMeasurement('g1b-parity', {
  pinnedBlock,
  positiveSamples: positives.length,
  negativeSamples: negativeChecked,
  componentsCovered: Object.keys(coverage).length,
  componentsInMirror: buckets.size,
  mismatches: mismatches.length,
  mismatchDetail: mismatches.slice(0, 10),
});
if (mismatches.length > 0) {
  fail('G1.b', { mismatches: mismatches.length, first: mismatches[0] });
}
pass('G1.b', {
  positives: positives.length,
  negatives: negativeChecked,
  componentsCovered: Object.keys(coverage).length,
  pinnedBlock,
});

// ------------------------------------------- C2 for G1.c (span accrual)

while (daemon.mirror.blockNumber - c1Block < SPAN_TARGET_BLOCKS) {
  const span = daemon.mirror.blockNumber - c1Block;
  console.log(`[g1] accruing G1.c span: ${span}/${SPAN_TARGET_BLOCKS} blocks`);
  await sleep(30_000);
}
await daemon.stop(); // includes the final checkpoint
const c2Path = path.join(ARTIFACTS_DIR, 'c2.v8snap');
await fs.copyFile(snapshotFilePath(config), c2Path);
const c2Block = daemon.mirror.blockNumber;
console.log(`[g1] C2 checkpoint copied at block ${c2Block} (span ${c2Block - c1Block})`);

await writeArtifact('g1a-result.json', {
  timeToLiveColdMs,
  c1Block,
  c2Block,
  dataDir,
  entriesAtStop: daemon.mirror.state.size,
  tripwires: daemon.getStatus().tripwires,
});

provider.destroy();
process.exit(0);
