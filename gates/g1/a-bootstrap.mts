// Gate G1.a + G1.b [live] — bootstrap and mirror parity.
//
// G1.a: the daemon must reach LIVE from an empty cache within the time
// budget, with > 10⁵ mirror state entries.
//
// G1.b: ≥ 500 (component, entity) samples from the checkpointed cache —
// covering every component id present, Bare and full alike — compared
// against direct eth_call reads (has/getRaw) pinned to the checkpoint's
// block, plus negative samples (pairs the mirror holds as absent must read
// absent on-chain). Zero mismatches allowed — except rows this script
// itself mechanically proves Kamigaze-inherited (PORT_PLAN amendment,
// 2026-07-20), all three conditions checked per row with evidence recorded
// in the measurement:
//   (1) absent on-chain at the pinned block,
//   (2) zero events for the pair within the log-retention window,
//   (3) re-served by Kamigaze on a fresh fetch.
// There is no human-waiver path. Value differences, mirror-absent/
// chain-present, and unproven mismatches always fail.
//
// Also produces the checkpoint artifacts for G1.c (c1/c2 snapshots spanning
// G1C_MIN_SPAN_BLOCKS of live streaming) and leaves the warm data dir for
// G1.d. Checkpoints are Kamigaze-consistent and block-exact (DESIGN §3.5).

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Contract, Interface } from 'ethers';

import { abi as worldAbi } from 'abi/World.json';
import { createDecode } from 'engine/encoders';
import { createKamigazeClient } from 'clients/kamigaze';
import { KamiLensDaemon } from '../../src/daemon';
import { resolveConfig } from '../../src/config';
import { tripwireReport } from '../../src/tripwires';
import {
  ARTIFACTS_DIR,
  fail,
  loadCacheFromSnapshotFile,
  makeProvider,
  pass,
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
const SPAN_TARGET_BLOCKS = Number(process.env.G1C_MIN_SPAN_BLOCKS ?? 600);
/** conservative retention floor for excusal check (2): a bit beyond the
 * measured ~1.02 M-block horizon, so the searched window is never smaller
 * than actual retention */
const RETENTION_SEARCH_SPAN = 1_100_000;
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
const backfill = statusAtLive.checkpoint!;
if (!backfill || backfill.stateEntries <= MIN_ENTRIES) {
  fail('G1.a', { reason: 'too few mirror entries', checkpoint: backfill });
}
await writeMeasurement('g1a-bootstrap', {
  timeToLiveColdMs,
  checkpoint: backfill,
  tripwires: statusAtLive.tripwires,
  degraded: statusAtLive.degraded,
});
pass('G1.a', {
  timeToLiveColdMs,
  entries: backfill.stateEntries,
  blockNumber: backfill.blockNumber,
  degraded: statusAtLive.degraded,
});

// C1: refresh checkpoint (Kamigaze-consistent, block-exact) and copy.
const c1Report = await daemon.checkpoint();
const c1Path = path.join(ARTIFACTS_DIR, 'c1.v8snap');
await fs.copyFile(snapshotFilePath(config), c1Path);
console.log(`[g1] C1 checkpoint copied at block ${c1Report.blockNumber} (${c1Report.durationMs}ms refresh)`);

// ---------------------------------------------------------------- G1.b

// Sample from the checkpointed cache: Kamigaze-indexed, pinned exactly at
// its GetStateBlock boundary.
const frozen = await loadCacheFromSnapshotFile(c1Path, config);
const pinnedBlock = frozen.blockNumber;

const provider = makeProvider(config);

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
console.log(`[g1] component registry: ${addressByComponent.size} addresses; pinned block ${pinnedBlock}`);

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

// Kamigotchi components expose getRaw(uint256)/has(uint256) (they are not
// vanilla solecs — no getRawValue). Only the uint256 overloads are declared
// so ethers binds the right selectors.
const componentAbi = [
  'function has(uint256 entity) view returns (bool)',
  'function getRaw(uint256 entity) view returns (bytes)',
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

function contractFor(cIdx: number, viaProvider = provider): Contract {
  const componentId = BigInt(frozen.components[cIdx]!).toString(16);
  const address = addressByComponent.get(componentId);
  if (!address) throw new Error(`no registry address for component ${frozen.components[cIdx]}`);
  return new Contract(address, componentAbi, viaProvider);
}

// The public RPC is load-balanced and backends disagree about very recent
// state: a pinned-block read can fail on one backend and succeed on another
// (observed live: 222/584 'missing revert data' failures that all read fine
// moments later). Retries therefore rotate to a fresh provider connection.
async function componentCall<T>(cIdx: number, invoke: (c: Contract) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const viaProvider = attempt === 0 ? provider : makeProvider(config);
    try {
      return await invoke(contractFor(cIdx, viaProvider));
    } catch (e) {
      lastError = e;
      await sleep(attempt === 0 ? 500 : 1000 * attempt);
    } finally {
      if (viaProvider !== provider) viaProvider.destroy();
    }
  }
  throw lastError;
}

// Pooled reads (2026-07-22 lesson, first learned at G6.b): ~600 sequential
// reads with spacing outlast the RPC's eth_call state window (measured
// <100 blocks today) and the pinned block ages out mid-gate — every read
// then fails 'missing revert data' regardless of backend rotation. The
// pool keeps per-read retry rotation; checks are unchanged.
type Candidate = { key: number; componentId: string; entityId: string; mirrorValue: unknown };
const hardFailures: Array<Record<string, unknown>> = [];
const excusalCandidates: Candidate[] = [];
const READ_CONCURRENCY = 8;
let checked = 0;
{
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < positives.length) {
      const key = positives[cursor++]!;
      const [cIdx, eIdx] = unpackTuple(key);
      const entityId = frozen.entities[eIdx]!;
      const componentId = frozen.components[cIdx]!;
      try {
        const has: boolean = await componentCall(cIdx, (c) =>
          c.has(BigInt(entityId), { blockTag: pinnedBlock })
        );
        if (!has) {
          // condition (1) established: absent on-chain at the pinned block
          excusalCandidates.push({ key, componentId, entityId, mirrorValue: frozen.state.get(key)! });
        } else {
          const raw: string = await componentCall(cIdx, (c) =>
            c.getRaw(BigInt(entityId), { blockTag: pinnedBlock })
          );
          const onChain = await decode(componentId, raw);
          const mirrorValue = frozen.state.get(key)!;
          if (stableJson(onChain) !== stableJson(mirrorValue)) {
            hardFailures.push({ kind: 'value-diff', componentId, entityId, mirrorValue, onChain });
          }
        }
      } catch (e) {
        hardFailures.push({ kind: 'unverifiable-rpc-read', componentId, entityId, error: String(e) });
      }
      checked++;
      if (checked % 100 === 0) console.log(`[g1.b] ${checked}/${positives.length} positive samples`);
    }
  };
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, () => worker()));
}

let negativeChecked = 0;
{
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < negatives.length) {
      const [cIdx, eIdx] = negatives[cursor++]!;
      const entityId = frozen.entities[eIdx]!;
      const componentId = frozen.components[cIdx]!;
      try {
        const has: boolean = await componentCall(cIdx, (c) =>
          c.has(BigInt(entityId), { blockTag: pinnedBlock })
        );
        if (has) {
          hardFailures.push({ kind: 'mirror-absent-chain-present', componentId, entityId });
        }
      } catch (e) {
        hardFailures.push({ kind: 'unverifiable-rpc-read', componentId, entityId, error: String(e) });
      }
      negativeChecked++;
    }
  };
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, () => worker()));
}

// ------------------------- excusal engine (mechanical, per row, no waiver)

const iface = new Interface(worldAbi);
const setTopic = iface.getEvent('ComponentValueSet')!.topicHash;
const removedTopic = iface.getEvent('ComponentValueRemoved')!.topicHash;

async function eventsInRetention(componentId: string, entityId: string): Promise<number> {
  const head = await provider.getBlockNumber();
  const from = Math.max(config.initialBlockNumber, head - RETENTION_SEARCH_SPAN);
  const cidTopic = '0x' + BigInt(componentId).toString(16).padStart(64, '0');
  const entTopic = '0x' + BigInt(entityId).toString(16).padStart(64, '0');
  let count = 0;
  for (let start = from; start <= head; start += 100_000) {
    const end = Math.min(start + 99_999, head);
    const logs = await withRetries(() =>
      provider.getLogs({
        address: config.worldAddress,
        fromBlock: start,
        toBlock: end,
        topics: [[setTopic, removedTopic], cidTopic, null, entTopic],
      })
    );
    count += logs.length;
    await sleep(200);
  }
  return count;
}

const excused: Array<Record<string, unknown>> = [];
if (excusalCandidates.length > 0) {
  console.log(`[g1.b] running excusal checks for ${excusalCandidates.length} candidate(s)`);
  // condition (3) needs one fresh full fetch; collect matches for all
  // candidates in a single pass, resolving rows via the checkpoint's own
  // Kamigaze-indexed tables.
  const reserved = new Map<number, string>();
  const wanted = new Set(excusalCandidates.map((c) => c.key));
  const client = createKamigazeClient(config.kamigazeUrl!);
  for await (const chunk of client.getState({ fromBlock: 0, removals: false })) {
    for (const row of chunk.state) {
      if (wanted.has(row.packedIdx)) {
        reserved.set(row.packedIdx, Buffer.from(row.data).toString('hex'));
      }
    }
  }

  for (const candidate of excusalCandidates) {
    const events = await eventsInRetention(candidate.componentId, candidate.entityId);
    const freshServe = reserved.get(candidate.key);
    const proofs = {
      absentOnChainAtPinnedBlock: true, // established during sampling
      eventsInRetentionWindow: events,
      kamigazeReservesOnFreshFetch: freshServe !== undefined,
      freshServeDataHex: freshServe ?? null,
    };
    if (events === 0 && freshServe !== undefined) {
      excused.push({ ...candidate, key: undefined, proofs });
      console.log(`[g1.b] EXCUSED (Kamigaze-inherited, proofs recorded): ${candidate.componentId} / ${candidate.entityId}`);
    } else {
      hardFailures.push({
        kind: 'unproven-absence-mismatch',
        componentId: candidate.componentId,
        entityId: candidate.entityId,
        proofs,
      });
    }
  }
}

await writeMeasurement('g1b-parity', {
  pinnedBlock,
  positiveSamples: positives.length,
  negativeSamples: negativeChecked,
  componentsCovered: Object.keys(coverage).length,
  componentsInMirror: buckets.size,
  hardFailures: hardFailures.length,
  excusedKamigazeInherited: excused,
  failureDetail: hardFailures.slice(0, 10),
  tripwires: tripwireReport(),
});
if (hardFailures.length > 0) {
  fail('G1.b', { hardFailures: hardFailures.length, first: hardFailures[0] });
}
pass('G1.b', {
  positives: positives.length,
  negatives: negativeChecked,
  componentsCovered: Object.keys(coverage).length,
  pinnedBlock,
  excused: excused.length,
});

// ------------------------------------------- C2 for G1.c (span accrual)

while (daemon.getStatus().liveBlockNumber - c1Report.blockNumber < SPAN_TARGET_BLOCKS) {
  const span = daemon.getStatus().liveBlockNumber - c1Report.blockNumber;
  console.log(`[g1] accruing G1.c span: ${span}/${SPAN_TARGET_BLOCKS} blocks`);
  await sleep(30_000);
}
const c2Report = await daemon.checkpoint();
await daemon.stop(); // runs one final refresh; C2 copy taken after stop
const c2Path = path.join(ARTIFACTS_DIR, 'c2.v8snap');
await fs.copyFile(snapshotFilePath(config), c2Path);
const c2Final = await loadCacheFromSnapshotFile(c2Path, config);
console.log(
  `[g1] C2 checkpoint copied at block ${c2Final.blockNumber} (span ${c2Final.blockNumber - c1Report.blockNumber})`
);

await writeArtifact('g1a-result.json', {
  timeToLiveColdMs,
  c1Block: c1Report.blockNumber,
  c2Block: c2Final.blockNumber,
  c2RefreshMs: c2Report.durationMs,
  dataDir,
  entriesAtStop: c2Final.state.size,
  tripwires: tripwireReport(),
});

provider.destroy();
process.exit(0);
