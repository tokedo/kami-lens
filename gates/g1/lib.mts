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
import os from 'node:os';
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

/** 1.0.0 (B8): the BASE a live gate heals from. The shared `c2.v8snap`
 * fixture ages (captured 2026-08-06, ~1M blocks behind by October), and
 * healing it to head is a replay of that whole span before the first chain
 * read — the gates that hard-coded it could not run. `--snapshot <path>` or
 * `LIVE_BASE_SNAPSHOT=<path>` names a fresher base; the default is still the
 * fixture. THE BASE DOES NOT CHANGE WHAT IS PROVED: these gates compare the
 * mirror against the chain at the mirror's own pinned block, so a closer
 * base only means less replay. Never written to, so no shared fixture is
 * touched. Record `path.basename(base)` in the measurement. */
export function liveBaseSnapshot(): string {
  const i = process.argv.indexOf('--snapshot');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (process.env.LIVE_BASE_SNAPSHOT) return process.env.LIVE_BASE_SNAPSHOT;
  return path.join(ARTIFACTS_DIR, 'c2.v8snap');
}

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

/** 1.0.0: WHICH keys two caches disagree on — the hash says that they do,
 * this says where. Keys are (componentId, entityId) in canonical hex, so
 * the two caches' own index spaces do not matter. */
export function diffCanonicalState(
  a: StateCache,
  b: StateCache,
  limit = 50
): { onlyA: number; onlyB: number; valueDiffs: number; samples: Record<string, unknown>[] } {
  const index = (cache: StateCache) => {
    const m = new Map<string, unknown>();
    for (const [key, value] of cache.state.entries()) {
      const [componentIdx, entityIdx] = unpackTuple(key);
      m.set(
        `${BigInt(cache.components[componentIdx]!).toString(16)}|${BigInt(cache.entities[entityIdx]!).toString(16)}`,
        value
      );
    }
    return m;
  };
  const ma = index(a);
  const mb = index(b);
  const samples: Record<string, unknown>[] = [];
  let onlyA = 0;
  let onlyB = 0;
  let valueDiffs = 0;
  for (const [k, va] of ma) {
    if (!mb.has(k)) {
      onlyA++;
      if (samples.length < limit) samples.push({ key: k, kind: 'onlyA', a: va });
    } else if (stableJson(va) !== stableJson(mb.get(k))) {
      valueDiffs++;
      if (samples.length < limit) samples.push({ key: k, kind: 'value', a: va, b: mb.get(k) });
    }
  }
  for (const [k, vb] of mb) {
    if (!ma.has(k)) {
      onlyB++;
      if (samples.length < limit) samples.push({ key: k, kind: 'onlyB', b: vb });
    }
  }
  return { onlyA, onlyB, valueDiffs, samples };
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

  // 1.0.0: EVERY CHUNK MUST BE PROVEN through its end. The reader reports
  // `provenThrough` (A2: the batch's own head, less the margin); the stock
  // chunked wrapper drops it, so a replay that ended near the head could be
  // answered short by a lagging backend and still be stamped `toBlock` —
  // exactly the over-claim A2 removed from the daemon. A short chunk is
  // re-read (paced) until a backend proves it, or the replay refuses.
  const events: Awaited<ReturnType<typeof fetchEventsInBlockRangeChunked>> = [];
  for (let from = fromBlock; from <= toBlock; from += chunkSize) {
    const to = Math.min(toBlock, from + chunkSize - 1);
    let proven = -1;
    for (let attempt = 0; attempt < 10; attempt++) {
      const chunk = (await fetchWorldEvents(from, to)) as Awaited<ReturnType<typeof fetchWorldEvents>> & {
        provenThrough?: number;
      };
      proven = chunk.provenThrough ?? to;
      if (proven >= to) {
        events.push(...chunk);
        break;
      }
      await sleep(1_500);
    }
    if (proven < to) {
      throw new Error(`replayOnto: ${from}..${to} not proven after 10 reads (provenThrough ${proven})`);
    }
  }
  void fetchEventsInBlockRangeChunked; // the unproven wrapper, kept importable for readers of this file
  storeStateEvents(cache, events);
  // storeEvents leaves blockNumber one behind the newest event's block;
  // the range is authoritative here.
  cache.blockNumber = toBlock;
}

// ---------------------------------------------------------- measurements

export async function writeMeasurement(gate: string, data: Record<string, unknown>): Promise<string> {
  await fs.mkdir(MEASUREMENTS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  // 1.0.0: MEASUREMENT_TAG keeps two same-day runs apart (a release whose
  // legs are gated on the same day would otherwise overwrite the first
  // leg's record with the second's)
  const tag = process.env.MEASUREMENT_TAG ? `-${process.env.MEASUREMENT_TAG}` : '';
  const file = path.join(MEASUREMENTS_DIR, `${gate}-${date}${tag}.json`);
  await fs.writeFile(
    file,
    redactLocalPaths(JSON.stringify({ gate, measuredAt: new Date().toISOString(), ...data }, null, 2)) + '\n'
  );
  return file;
}

/** 1.0.0: a record is published with the repository, so the machine it was
 * taken on does not leak into it — this checkout's path, the home directory
 * and the OS temp directory are written as <repo>, <home> and <tmp>. */
export function redactLocalPaths(text: string): string {
  const pairs: [string, string][] = [
    [REPO_ROOT, '<repo>'],
    ['/private' + os.tmpdir(), '<tmp>'],
    [os.tmpdir(), '<tmp>'],
    ['/private/tmp', '<tmp>'],
    [os.homedir(), '<home>'],
  ];
  let out = text;
  for (const [from, to] of pairs) if (from && from.length > 1) out = out.split(from).join(to);
  return out;
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
