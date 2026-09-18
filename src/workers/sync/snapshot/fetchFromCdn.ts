/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/workers/sync/snapshot/fetchFromCdn.ts
 * forward-port: @ 21f419e63e0a7f6b642c255efeb89dd1c288de1c (sync-affecting
 *           bucket, ahead of the pin — SPEC §4.2). The file does not exist
 *           at the pin; it arrives whole with Asphodel-OS/kamigotchi#2475.
 * changes:  THREE divergences as of 0.6.3 (L-11), and until then none — the
 *           0.6.2 banner said "every byte of the body is upstream's" and
 *           that is no longer true, so it is restated rather than amended.
 *           All three are the same measured defect (kami-factory,
 *           2026-09-18: a HEALTHY CDN load killed by the daemon's own 90-s
 *           pre-LIVE stall watchdog, cold->LIVE 271 s instead of 118 s):
 *
 *          13. THE APPLY YIELDS TO THE EVENT LOOP. Every values and entities
 *              apply runs through `applyInSlices` (state/apply.ts) on a
 *              50 ms time budget, parking on `setImmediate` between slices.
 *              Upstream applies a whole chunk in one synchronous-to-the-
 *              macrotask-queue stretch — `await decode()` per row yields to
 *              MICROTASKS only — which on 2 vCPUs is ~11 s per chunk with no
 *              socket read and no timer serviced. Rationale, the measurement
 *              and the interleaving-safety argument: state/apply.ts and the
 *              note above `applyValues` below.
 *          14. PROGRESS IS REPORTED ON ROWS, NOT ON WHOLE CHUNKS, and a
 *              chunk fetch and a chunk retry change the MESSAGE. The
 *              daemon's stall watchdog compares
 *              `state|percentage|msg|liveBlockNumber` (divergence 10), and
 *              on whole-chunk progress that fingerprint moved four times for
 *              the entire load — so one retried chunk plus its apply
 *              exceeded 90 s of silence and the daemon restarted a load that
 *              was working. Upstream's single monotonic-by-construction
 *              derivation is KEPT; only the numerators become fractional
 *              (see `reportProgress`).
 *          15. CONCURRENT CHUNK FETCHES ARE CAPPED BY AVAILABLE PARALLELISM.
 *              Upstream's 6 stands on a box with cores to spare; on a 2-vCPU
 *              box it means five ~11 MB bodies in flight that the thread
 *              cannot read while it applies the sixth, each on a wall-clock
 *              `AbortSignal.timeout`. `CHUNK_TIMEOUT_MS` itself is
 *              untouched (upstream's 30 s).
 *
 *           The lens's OTHER divergences around this path still live in
 *           Worker.ts (divergences 8-12), not in here.
 */

import os from 'node:os';

import {
  ComponentsResponse,
  EntitiesResponse,
  KamigazeServiceClient,
  StateResponse,
} from 'clients/kamigaze';
import { createDecode } from 'engine/encoders';
import { log } from 'utils/logger';
import {
  applyInSlices,
  createStateCache,
  StateCache,
  storeStateBlock,
  storeStateComponents,
  storeStateEntities,
  storeStateValues,
} from '../state';
import {
  CDN_FULL_THRESHOLD_BLOCKS,
  CHUNK_TIMEOUT_MS,
  fetchStateBlock,
  MAX_RETRIES,
  RETRY_DELAYS,
} from './fetch';

export type StateManifest = {
  nonce: number;
  block: number;
  // Key prefix of this export's chunk set, taken verbatim rather than composed here. Nonce
  // and block do not identify an image on their own, so the exporter gives each export its
  // own prefix and the layout stays its business alone.
  prefix: string;
  values: number;
  entities: number;
};

// the exporter is stuck and its chunk set aged out of the bucket while latest.json
// survived, so the manifest points at keys that no longer exist. Never retryable.
class CdnChunkGone extends Error {
  constructor(readonly url: string) {
    super(`[cdn] chunk gone: ${url}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The manifest gates the whole path decision and is under 100 bytes, so it gets a much
// tighter budget than a chunk: a stalled read here is dead time before the gRPC fallback.
const MANIFEST_TIMEOUT_MS = 5000;

// Chunk counts are load bearing in a way a bad value cannot announce: fetchFromCdn derives
// its request list from them, so a missing or zero count fetches nothing, raises no 404, and
// still finalises the cache at manifest.block. The client would then bridge forward from a
// block whose state it never loaded and stay silently incomplete. A malformed prefix is
// self-correcting by comparison, since it 404s into the chunk-gone path.
//
// Every count is > 0 on any published manifest: the exporter refuses to run until
// GetLatestStateBlock() > 0, so there is always at least one values and one entities chunk.
// Anything else is corruption, and rejecting it falls back to gRPC.
const isValidManifest = (value: unknown): value is StateManifest => {
  const m = value as Partial<StateManifest> | null;
  const positiveInt = (n: unknown): boolean => Number.isInteger(n) && (n as number) > 0;

  return (
    !!m &&
    typeof m.prefix === 'string' &&
    m.prefix.length > 0 &&
    positiveInt(m.nonce) &&
    positiveInt(m.block) &&
    positiveInt(m.values) &&
    positiveInt(m.entities)
  );
};

export const fetchManifest = async (cdnUrl: string): Promise<StateManifest | undefined> => {
  try {
    const res = await fetch(`${cdnUrl}/latest.json`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn('[cdn] manifest unavailable', { status: res.status });
      return undefined;
    }

    const parsed = await res.json();
    if (!isValidManifest(parsed)) {
      log.warn('[cdn] manifest malformed, using gRPC', { manifest: parsed });
      return undefined;
    }
    return parsed;
  } catch (e) {
    log.warn('[cdn] manifest unavailable', e);
    return undefined;
  }
};

/**
 * Decide whether this boot should full-load from the CDN, returning the manifest to
 * load when it should and undefined when the gRPC path should run instead.
 */
export const planCdnLoad = async (
  cdnUrl: string,
  client: KamigazeServiceClient,
  cache: StateCache
): Promise<StateManifest | undefined> => {
  const [manifest, live] = await Promise.all([fetchManifest(cdnUrl), fetchStateBlock(client)]);
  if (!manifest) return undefined;

  // the manifest is up to one export interval old. After a reindex it still carries the
  // previous nonce while the service reports the new one, and its indices are dead.
  if (manifest.nonce !== live.nonce) {
    log.warn('[cdn] manifest nonce differs from live nonce, using gRPC', {
      manifestNonce: manifest.nonce,
      liveNonce: live.nonce,
    });
    return undefined;
  }

  const cold =
    cache.lastKamigazeBlock === 0 ||
    cache.kamigazeNonce !== manifest.nonce ||
    manifest.block - cache.lastKamigazeBlock > CDN_FULL_THRESHOLD_BLOCKS;
  if (!cold) return undefined;

  log.info('[cdn] cold boot: loading full state from CDN', {
    block: manifest.block,
    nonce: manifest.nonce,
    values: manifest.values,
    entities: manifest.entities,
  });
  return manifest;
};

// divergence 14: `onRetry` is the only addition — a retry is ACTIVITY, and
// the daemon's stall watchdog can only learn that from a fingerprint change.
const fetchChunk = async (
  url: string,
  onRetry?: (attempt: number, max: number) => void
): Promise<Uint8Array> => {
  let retryCount = 0;

  while (retryCount <= MAX_RETRIES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS) });
      if (res.status === 404 || res.status === 403) throw new CdnChunkGone(url);
      if (!res.ok) throw new Error(`[cdn] chunk ${url} responded ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (e instanceof CdnChunkGone) throw e;

      retryCount++;
      if (retryCount > MAX_RETRIES) throw e;

      const delay = RETRY_DELAYS[Math.min(retryCount - 1, RETRY_DELAYS.length - 1)];
      log.warn(`[cdn] chunk retry ${retryCount}/${MAX_RETRIES} in ${delay / 1000}s`, { url, e });
      onRetry?.(retryCount, MAX_RETRIES);
      await sleep(delay);
    }
  }

  throw new Error(`[cdn] chunk ${url} failed after ${MAX_RETRIES} retries`);
};

/**
 * Divergence 15: how many chunk bodies may be in flight at once.
 *
 * Upstream's 6 is right on a machine with cores to spare. It is wrong on a
 * 2-vCPU box, where the ONE JS thread spends ~11 s applying a values chunk
 * and cannot read the other five bodies while it does — and each of those
 * bodies is racing `AbortSignal.timeout(CHUNK_TIMEOUT_MS)`, a WALL clock.
 * Measured (kami-factory, 2026-09-18): three `TimeoutError` chunk retries
 * across two bootstrap attempts, each a full ~11 MB re-fetch, on a link that
 * was never the problem — `fetchSecondsInflatedByBlocking` 165 s against
 * 80 s of wall.
 *
 * `availableParallelism()` reads the process's CPU AFFINITY on Linux, not
 * the cgroup CPU quota — so `docker --cpus 1` alone does NOT narrow this and
 * gate G10.e pins with `--cpuset-cpus` as well. That is a property of the
 * gate, not a reason to pick a different signal: affinity is what a real
 * small VM actually has (kami-factory: 2).
 */
export const cdnFetchConcurrency = (): number => {
  const cores = os.availableParallelism?.() ?? 6;
  return cores <= 2 ? 2 : 6;
};

// starts every task with at most `limit` in flight, handing back one promise per task
// in task order so callers can consume results in whatever order they need.
const startWithLimit = <T>(tasks: (() => Promise<T>)[], limit = 6): Promise<T>[] => {
  const settle: { resolve: (value: T) => void; reject: (reason: unknown) => void }[] = [];
  const results = tasks.map((_, i) => {
    const result = new Promise<T>((resolve, reject) => (settle[i] = { resolve, reject }));
    // a chunk that fails before its turn to be consumed is still handled here
    result.catch(() => {});
    return result;
  });

  let next = 0;
  const drain = async () => {
    while (next < tasks.length) {
      const i = next++;
      try {
        settle[i].resolve(await tasks[i]());
      } catch (e) {
        settle[i].reject(e);
      }
    }
  };
  for (let i = 0; i < Math.min(limit, tasks.length); i++) void drain();

  return results;
};

/**
 * Load a full state image from the CDN into a fresh StateCache. Components land first
 * (values decode against them), values apply in any order, entities strictly in index
 * order since storeStateEntities only appends at the tail.
 */
export const fetchFromCdn = async (
  cdnUrl: string,
  manifest: StateManifest,
  decode: ReturnType<typeof createDecode>,
  setPercentage: (percentage: number) => void,
  setMessage?: (msg: string) => void,
  retried = false
): Promise<StateCache> => {
  const cache = createStateCache();
  const prefix = `${cdnUrl}/${manifest.prefix}`;

  // Fetching and applying overlap, so phase marks cannot separate them the way the
  // Worker's connecting/setup/backfill marks do. These are accumulated instead, and the
  // sums deliberately do not add up to wall clock. Read them as:
  //   applyMs vs wallMs  — applying is single-threaded and additive, so if the two are
  //                        close then decoding is the whole story and the network is not
  //   fetchMs            — inflated whenever the thread is busy, since it includes waiting
  //                        for JS to read the body. High fetchMs alongside high applyMs
  //                        means blocking, not a slow link
  //   protoMs vs valuesApplyMs — protobuf parse against the per-row ABI decode
  //   parkedMs           — divergence 13: time the applies handed BACK to
  //                        the event loop. It is not apply time and it is
  //                        not fetch time; it is the cost of the fix, and
  //                        `microsecondsPerValueRow` excludes it so the
  //                        decode figure stays comparable across releases
  const t = {
    fetchMs: 0,
    protoMs: 0,
    valuesApplyMs: 0,
    entitiesApplyMs: 0,
    parkedMs: 0,
    applySlices: 0,
    chunkRetries: 0,
    valueRows: 0,
    entityRows: 0,
    bytes: 0,
  };
  const wallStart = performance.now();

  // divergence 14: the message carries chunk-level activity, because
  // `percentage` cannot move while a chunk is merely being FETCHED and the
  // watchdog's fingerprint includes `msg`. Deliberately free of the substring
  // 'retrying in': daemon.ts onFailed reads that as "the worker is handling
  // this itself" and stands down (its own sanitizer exists for the same
  // reason).
  let chunksFetched = 0;
  const chunkTotal = manifest.values + manifest.entities;
  let lastRetryNote = '';
  const stateMessage = () => {
    const fetched = `${chunksFetched}/${chunkTotal} chunks fetched`;
    setMessage?.(`Querying for State (${fetched}${lastRetryNote})`);
  };

  const timedFetch = (url: string, name: string) => async () => {
    const started = performance.now();
    const bytes = await fetchChunk(url, (attempt, max) => {
      t.chunkRetries++;
      lastRetryNote = `, retry ${name} ${attempt}/${max}`;
      stateMessage();
    });
    t.fetchMs += performance.now() - started;
    t.bytes += bytes.byteLength;
    chunksFetched++;
    stateMessage();
    return bytes;
  };

  try {
    setMessage?.('Querying for Components');
    const componentBytes = await fetchChunk(`${prefix}/components.pb.gz`);
    storeStateComponents(cache, ComponentsResponse.decode(componentBytes).components);
    cache.lastKamigazeComponent = cache.components.length - 1;
    setPercentage(5);

    stateMessage();
    const names = [
      ...Array.from({ length: manifest.values }, (_, i) => `values-${i}`),
      ...Array.from({ length: manifest.entities }, (_, i) => `entities-${i}`),
    ];
    // divergence 15: the in-flight cap comes from available parallelism.
    // Logged, because a boot that behaved differently from the last one
    // must be able to say why without a second run.
    const limit = cdnFetchConcurrency();
    log.info('[cdn] chunk fetch concurrency', {
      limit,
      availableParallelism: os.availableParallelism?.() ?? null,
      chunks: chunkTotal,
    });
    const chunks = startWithLimit(
      names.map((name) => timedFetch(`${prefix}/${name}.pb.gz`, name)),
      limit
    );
    const valueChunks = chunks.slice(0, manifest.values);
    const entityChunks = chunks.slice(manifest.values);

    // Values and entities apply concurrently, so two writers sharing one percentage cannot
    // own separate ranges: entities finish roughly 25x sooner, so they used to race the bar
    // to 100 before the values snapped it back and left it stranded at 65 when the load
    // finished. One function reading both counters is monotonic by construction, since
    // neither counter ever decreases.
    //
    // The split is weighted by where the time goes, not by chunk count. A measured cold
    // boot spends 36.3s in values against 1.4s in entities, so dividing the bar evenly
    // across nine chunks would sprint through five of them and stall on the rest.
    //
    // DIVERGENCE 14 KEEPS THAT DERIVATION AND MAKES THE NUMERATORS
    // FRACTIONAL. Each chunk contributes `rowsApplied / rowsInChunk` ∈ [0,1]
    // instead of 0-then-1, so the bar moves roughly once per 50 ms slice
    // while the denominators stay the manifest's fixed chunk counts. It is
    // monotonic for exactly upstream's reason — every per-chunk term only
    // ever increases, so their sum only ever increases — which a
    // rows-over-estimated-total formula would NOT have been, because the
    // estimate of the total shrinks as fatter chunks decode.
    //
    // DIVERGENCE 13 (the sliced apply) AND WHY INTERLEAVING IS SAFE.
    // `applyInSlices` parks between slices, so two values chunks can now
    // interleave their applies at slice granularity. That is not a new
    // property: `storeValues` does `await decode(...)` PER ROW, and `decode`
    // is an async function that never awaits, so concurrent applies already
    // interleave at ROW granularity today — and the chunks themselves are
    // consumed in whatever order the network serves them, so the apply order
    // ACROSS chunks is already arbitrary. What that arbitrary order is
    // allowed to be is bounded by the image itself: a values chunk set is a
    // partition of ONE state image at ONE block, where a (component, entity)
    // key has exactly one current value, so `valueCache.set(packedIdx, …)`
    // never sees the same key from two chunks and last-write-per-key cannot
    // arise. The gRPC path says the same thing from the other side: its
    // resume rewinds one block precisely BECAUSE re-serving a boundary
    // block's rows is idempotent (fetch.ts `resumeBlock`).
    // The two orderings that ARE load-bearing are untouched: components land
    // before any value (`storeStateComponents` above, awaited, and the
    // decode stub in test/cdn-full-load.test.ts is component-sensitive to
    // keep it that way), and entities stay strictly in index order —
    // `applyEntitiesInOrder` is still one sequential awaited loop, and
    // slicing an array in order preserves order within a chunk too, which is
    // what `storeStateEntities`' append-at-the-tail check requires.
    let valuesApplied = 0;
    let entitiesApplied = 0;
    const reportProgress = () => {
      const values = (valuesApplied / manifest.values) * 90;
      const entities = (entitiesApplied / manifest.entities) * 5;
      setPercentage(+(5 + values + entities).toFixed(1));
    };
    /** One chunk's fractional contribution, reported as its rows land.
     * `settle()` credits the remainder when the chunk is done — an EMPTY
     * chunk reports no slices at all, and without this the bar would stop
     * short of 100 on an image the manifest declared but the exporter left
     * empty. Upstream's whole-chunk counter could not have that hole. */
    const chunkProgress = (counter: 'values' | 'entities') => {
      let credited = 0;
      const credit = (share: number) => {
        const delta = share - credited;
        credited = share;
        if (counter === 'values') valuesApplied += delta;
        else entitiesApplied += delta;
        reportProgress();
      };
      return {
        onSlice: (rowsApplied: number, rowsTotal: number) =>
          credit(rowsTotal > 0 ? rowsApplied / rowsTotal : 1),
        settle: () => credit(1),
      };
    };

    const applyValues = valueChunks.map((chunk) =>
      chunk.then(async (bytes) => {
        const protoStart = performance.now();
        const state = StateResponse.decode(bytes).state;
        t.protoMs += performance.now() - protoStart;

        const progress = chunkProgress('values');
        const sliced = await applyInSlices(
          state,
          (slice) => storeStateValues(cache, slice, decode),
          { onSlice: progress.onSlice }
        );
        progress.settle();
        t.valuesApplyMs += sliced.applyMs;
        t.parkedMs += sliced.parkedMs;
        t.applySlices += sliced.slices;
        t.valueRows += state.length;
      })
    );

    const applyEntitiesInOrder = async () => {
      for (let i = 0; i < entityChunks.length; i++) {
        const bytes = await entityChunks[i];
        const protoStart = performance.now();
        const entities = EntitiesResponse.decode(bytes).entities;
        t.protoMs += performance.now() - protoStart;

        const progress = chunkProgress('entities');
        const sliced = await applyInSlices(
          entities,
          (slice) => storeStateEntities(cache, slice),
          { onSlice: progress.onSlice }
        );
        progress.settle();
        t.entitiesApplyMs += sliced.applyMs;
        t.parkedMs += sliced.parkedMs;
        t.applySlices += sliced.slices;
        t.entityRows += entities.length;
      }
    };

    await Promise.all([Promise.all(applyValues), applyEntitiesInOrder()]);

    const wallMs = performance.now() - wallStart;
    const applyMs = t.valuesApplyMs + t.entitiesApplyMs;
    log.info('[cdn] load profile', {
      wallSeconds: +(wallMs / 1000).toFixed(2),
      applySeconds: +(applyMs / 1000).toFixed(2),
      applyShareOfWall: `${((applyMs / wallMs) * 100).toFixed(0)}%`,
      valuesApplySeconds: +(t.valuesApplyMs / 1000).toFixed(2),
      entitiesApplySeconds: +(t.entitiesApplyMs / 1000).toFixed(2),
      protoParseSeconds: +(t.protoMs / 1000).toFixed(2),
      fetchSecondsInflatedByBlocking: +(t.fetchMs / 1000).toFixed(2),
      // divergence 13's own cost and frequency, so a boot can be read
      // against the release that introduced it rather than against a guess.
      // `applySeconds` and `microsecondsPerValueRow` EXCLUDE parked time.
      parkedSeconds: +(t.parkedMs / 1000).toFixed(2),
      applySlices: t.applySlices,
      chunkFetchConcurrency: cdnFetchConcurrency(),
      chunkRetries: t.chunkRetries,
      valueRows: t.valueRows,
      entityRows: t.entityRows,
      microsecondsPerValueRow: +((t.valuesApplyMs * 1000) / Math.max(t.valueRows, 1)).toFixed(1),
      megabytes: +(t.bytes / 1e6).toFixed(1),
      megabytesPerSecond: +(t.bytes / 1e6 / (wallMs / 1000)).toFixed(1),
    });

    storeStateBlock(cache, { blockNumber: manifest.block, nonce: manifest.nonce });
    cache.lastKamigazeBlock = manifest.block;
    cache.kamigazeNonce = manifest.nonce;
    cache.lastKamigazeEntity = cache.entities.length - 1;

    return cache;
  } catch (e) {
    if (e instanceof CdnChunkGone && !retried) {
      const next = await fetchManifest(cdnUrl);
      if (next && next.nonce === manifest.nonce && next.block !== manifest.block) {
        log.warn('[cdn] chunk set expired mid-load, restarting from the current manifest', {
          from: manifest.block,
          to: next.block,
        });
        return fetchFromCdn(cdnUrl, next, decode, setPercentage, setMessage, true);
      }
    }
    throw e;
  }
};
