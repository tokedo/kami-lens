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

/**
 * Replay World events (cache.blockNumber, toBlock] onto the cache via RPC
 * and stamp the cache at toBlock.
 *
 * Also the block-boundary healer: a checkpoint can truncate its newest
 * block mid-batch (upstream's storeEvent marks blockNumber one behind the
 * newest event), and replaying that block re-applies its full event set —
 * ECS events are idempotent whole-value upserts, so the cache converges to
 * the exact post-toBlock state.
 */
export async function replayOnto(
  cache: StateCache,
  fetchWorldEvents: ReturnType<typeof makeFetchWorldEvents>,
  toBlock: number,
  chunkSize = 500
): Promise<void> {
  const fromBlock = cache.blockNumber + 1;
  if (fromBlock > toBlock) return;
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
