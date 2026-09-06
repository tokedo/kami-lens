// Gate G1 shared library (kami-lens native, not a port).
//
// Canonical state hash (PORT_PLAN "Gate philosophy"): the mirror's
// (componentId, entityId) → decoded value map, serialized in sorted key
// order and SHA-256'd. Defined once here; every gate that says "state hash"
// uses this. Component/entity ids are normalized via BigInt so padding
// differences can never affect the hash; values are serialized with
// recursively sorted object keys.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { unpackTuple } from '@mud-classic/utils';
import { Interface, JsonRpcProvider } from 'ethers';

import { abi as worldAbi } from 'abi/World.json';
import { VERSION as CACHE_VERSION } from 'cache/db';
import { createDecode } from 'engine/encoders';
import { KamiLensConfig } from '../../src/config';
import {
  StateCache,
  createStateCache,
  loadStateCacheFromStore,
  storeStateEvents,
} from 'workers/sync/state';
import { FileStateStore, getID } from 'workers/sync/state/store';
import { createFetchWorldEventsInBlockRange, fetchEventsInBlockRangeChunked } from 'workers/sync/utils';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
export const ARTIFACTS_DIR = path.join(REPO_ROOT, 'gates', '.artifacts');
export const MEASUREMENTS_DIR = path.join(REPO_ROOT, 'docs', 'measurements');

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- hashing

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(typeof value === 'bigint' ? value.toString() : value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

export type HashReport = { hash: string; entries: number; blockNumber: number };

/** Canonical state hash of a StateCache (see header). */
export function canonicalStateHash(cache: StateCache): HashReport {
  const lines: string[] = [];
  for (const [key, value] of cache.state.entries()) {
    const [componentIdx, entityIdx] = unpackTuple(key);
    const componentId = cache.components[componentIdx];
    const entityId = cache.entities[entityIdx];
    if (componentId == null || entityId == null) {
      throw new Error(`state entry ${key} references unknown component/entity index`);
    }
    lines.push(`${BigInt(componentId).toString(16)}|${BigInt(entityId).toString(16)}|${stableJson(value)}`);
  }
  lines.sort();
  const hash = createHash('sha256');
  for (const line of lines) hash.update(line + '\n');
  return { hash: hash.digest('hex'), entries: lines.length, blockNumber: cache.blockNumber };
}

// ------------------------------------------------------------- snapshots

/** Load a StateCache from a snapshot file at an explicit path. */
export async function loadCacheFromSnapshotFile(
  filePath: string,
  config: KamiLensConfig
): Promise<StateCache> {
  const store = new FileStateStore(filePath, {
    chainId: config.chainId,
    worldAddress: config.worldAddress,
    cacheVersion: CACHE_VERSION,
  });
  await store.load();
  return loadStateCacheFromStore(store);
}

export function snapshotFileName(config: KamiLensConfig): string {
  return `${getID('ECSCache', config.chainId, config.worldAddress, CACHE_VERSION)}.v8snap`;
}

export function snapshotFilePath(config: KamiLensConfig): string {
  return path.join(config.dataDir, snapshotFileName(config));
}

/** Deep-copy the hashed portion of a StateCache (state map + id tables). */
export function cloneStateCache(cache: StateCache): StateCache {
  const copy = createStateCache();
  copy.components = [...cache.components];
  copy.entities = [...cache.entities];
  copy.componentToIndex = new Map(cache.componentToIndex);
  copy.entityToIndex = new Map(cache.entityToIndex);
  copy.state = new Map(cache.state);
  copy.blockNumber = cache.blockNumber;
  copy.lastKamigazeBlock = cache.lastKamigazeBlock;
  copy.lastKamigazeEntity = cache.lastKamigazeEntity;
  copy.lastKamigazeComponent = cache.lastKamigazeComponent;
  copy.kamigazeNonce = cache.kamigazeNonce;
  return copy;
}

// ------------------------------------------------------------ RPC replay

export function makeProvider(config: KamiLensConfig): JsonRpcProvider {
  return new JsonRpcProvider(
    config.jsonRpcUrl,
    { chainId: config.chainId, name: 'yominet' },
    { staticNetwork: true }
  );
}

export function makeFetchWorldEvents(provider: JsonRpcProvider, config: KamiLensConfig) {
  const decode = createDecode();
  return createFetchWorldEventsInBlockRange(
    provider,
    { address: config.worldAddress, abi: new Interface(worldAbi) },
    false,
    decode
  );
}

/** Measured `eth_getLogs` retention on the public Yominet endpoint: the
 * trailing ~1.02 M blocks (~25 days). Beyond it the endpoint answers an EMPTY
 * result with HTTP 200 — not an error — which is the entire reason the guard
 * below exists.
 *
 * G1.f re-measures it by bisection on every run, and the value drifts:
 *
 *   1,025,971 @ head 31,230,021 (2026-07-22)
 *   1,025,888 @ head 33,004,025 (2026-09-06)
 *
 * This constant takes the SMALLEST measurement on record, not the newest and
 * not an average. The guard's job is to refuse a replay that would read
 * pruned logs, so where the measurements disagree the conservative one is the
 * only honest choice — a horizon set 83 blocks too generous is 83 blocks in
 * which the guard passes a replay whose logs are already gone. No safety
 * margin is invented on top: every number here is one G1.f measured.
 *
 * A future G1.f run that measures lower should lower this. */
export const RETENTION_BLOCKS = 1_025_888;

/** Thrown by replayOnto when the range it was asked for cannot be honestly
 * read. Carries the numbers, so a caller's failure line does not have to
 * re-derive them. */
export class ReplayRetentionError extends Error {
  constructor(
    readonly detail: {
      reason: string;
      fromBlock: number;
      toBlock: number;
      head: number | null;
      spanBlocks: number;
      blocksBehindHead: number | null;
      retentionBlocks: number;
    }
  ) {
    super(
      `replayOnto refused: ${detail.reason} — range [${detail.fromBlock}, ${detail.toBlock}] ` +
        `(span ${detail.spanBlocks} blocks` +
        (detail.head !== null
          ? `, fromBlock ${detail.blocksBehindHead} blocks behind head ${detail.head}`
          : '') +
        `) against a measured log retention of ${detail.retentionBlocks} blocks. ` +
        `Beyond retention eth_getLogs answers EMPTY with HTTP 200, so this replay would ` +
        `build a mirror with a silent hole in it and every comparison against it would be ` +
        `meaningless. Capture a fresh snapshot (G1.a) rather than replaying this one.`
    );
    this.name = 'ReplayRetentionError';
  }
}

/**
 * Replay World events (cache.blockNumber, toBlock] onto the cache via RPC
 * and stamp the cache at toBlock.
 *
 * Also the block-boundary healer: a checkpoint can truncate its newest
 * block mid-batch (upstream's storeEvent marks blockNumber one behind the
 * newest event), and replaying that block re-applies its full event set —
 * ECS events are idempotent whole-value upserts, so the cache converges to
 * the exact post-toBlock state.
 *
 * RETENTION GUARD (0.6.1). A replay whose range has fallen out of the RPC's
 * log-retention window returns no logs and no error, so the cache is stamped
 * at toBlock while holding none of the state between — and every gate built
 * on it then compares the chain against a mirror with a hole in it and PASSES
 * for nothing. That is the class of gate this repo does not keep, and it was
 * not hypothetical: on 2026-09-06 `gates/.artifacts/c2.v8snap` sat 1,207,995
 * blocks behind head against ~1.02 M blocks of retention, and a probe of the
 * 200 blocks immediately after the fixture's own block — a range the fixture
 * itself proves was live — returned ZERO logs with HTTP 200
 * (docs/measurements/fixture-retention-2026-09-06.json).
 *
 * The load-bearing predicate is `head - fromBlock`, NOT the span. Retention is
 * measured backwards from the CHAIN HEAD, so a short replay between two blocks
 * that are both a year old is exactly as pruned as a long one — and it is the
 * short-span case that would slip past a span check while being just as
 * silently wrong. The span check is kept as a cheap second condition (a range
 * longer than the whole window cannot fit inside it wherever it sits), and
 * both numbers are named in the refusal.
 *
 * Pass `provider` to arm the guard. Without one the head is unknown and only
 * the span condition can be checked; callers that replay against live RPC
 * SHOULD pass it — every gate in this repo does.
 */
export async function replayOnto(
  cache: StateCache,
  fetchWorldEvents: ReturnType<typeof makeFetchWorldEvents>,
  toBlock: number,
  opts: { provider?: JsonRpcProvider; chunkSize?: number; retentionBlocks?: number } = {}
): Promise<void> {
  const { provider, chunkSize = 500, retentionBlocks = RETENTION_BLOCKS } = opts;
  const fromBlock = cache.blockNumber + 1;
  if (fromBlock > toBlock) return;

  const spanBlocks = toBlock - fromBlock + 1;
  const head = provider ? await provider.getBlockNumber() : null;
  const blocksBehindHead = head === null ? null : head - fromBlock;

  if (blocksBehindHead !== null && blocksBehindHead > retentionBlocks) {
    throw new ReplayRetentionError({
      reason: 'the range STARTS beyond the log-retention horizon',
      fromBlock,
      toBlock,
      head,
      spanBlocks,
      blocksBehindHead,
      retentionBlocks,
    });
  }
  if (spanBlocks > retentionBlocks) {
    throw new ReplayRetentionError({
      reason: 'the range is LONGER than the whole retention window',
      fromBlock,
      toBlock,
      head,
      spanBlocks,
      blocksBehindHead,
      retentionBlocks,
    });
  }

  const events = await fetchEventsInBlockRangeChunked(fetchWorldEvents, fromBlock, toBlock, chunkSize);
  storeStateEvents(cache, events);
  // storeEvents leaves blockNumber one behind the newest event's block;
  // the range is authoritative here.
  cache.blockNumber = toBlock;
}

// ---------------------------------------------------------- measurements

export async function writeMeasurement(gate: string, data: Record<string, unknown>): Promise<string> {
  await fs.mkdir(MEASUREMENTS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(MEASUREMENTS_DIR, `${gate}-${date}.json`);
  await fs.writeFile(file, JSON.stringify({ gate, measuredAt: new Date().toISOString(), ...data }, null, 2) + '\n');
  return file;
}

export async function writeArtifact(name: string, data: Record<string, unknown>): Promise<string> {
  await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
  const file = path.join(ARTIFACTS_DIR, name);
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

export async function readArtifact<T>(name: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(ARTIFACTS_DIR, name), 'utf8')) as T;
}

export function pass(gate: string, detail: Record<string, unknown>): void {
  console.log(`PASS ${gate} ${JSON.stringify(detail)}`);
}

export function fail(gate: string, detail: Record<string, unknown>): never {
  console.error(`FAIL ${gate} ${JSON.stringify(detail)}`);
  process.exit(1);
}
