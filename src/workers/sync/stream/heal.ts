// kami-lens native module (not a port): the one recovery primitive,
// DESIGN §3.17 (2026-09-06, "L-1").
//
// PRINCIPLE. Kamigaze's stream and its GetEventsSince diff are fast paths.
// The chain is the only authority, and every recovery path reads it through
// `eth_getLogs` on the World contract. The mirror is "latest write per key
// across everything applied", so the one ordering invariant is: never apply a
// log older than one already applied for the same key. With a serialized
// pipeline that holds whenever a recovery range ENDS AT THE CURRENT CURSOR
// and the RPC node is at or past that block — which is what the rpcHead
// guard below exists to establish.
//
// WHY THE GUARD IS NOT REDUNDANT. blocks.ts carries upstream's own
// wait-for-the-node ladder (`requireMinimumBlockNumber`), but it is reached
// only when `supportsBatchQueries` is set, and the daemon sets
// `options: { batch: false }` (daemon.ts). So that ladder is dead code here
// and this is the only such guard in the process.
//
// A DEFERRED RANGE IS NEVER PARTIALLY APPLIED. If the node is behind, or the
// subscription is torn down mid-heal, the range is recorded as unhealed and
// nothing is applied — the next reconcile tick (or the next gap heal, if it
// comes first) covers it. Applying half a range would advance the cursor over
// blocks that were never read, which is the 0.5.3 defect this replaces.

import { log } from 'utils/logger';
import { Components } from 'engine/recs';
import { recordUnhealed, clearUnhealed, syncHealth } from '../../../sync-health';
import { NetworkComponentUpdate } from '../../types';
import type { FetchWorldEvents } from './stream';

/** Above this span a gap is healed through Kamigaze's diff first (~40
 * chunked eth_getLogs would otherwise outlive the subscription), and only
 * the head is then topped up from the chain. Measured 2026-08-26..09-06:
 * the modal stream gap is 4 blocks and nothing observed came near this. */
export const GAP_RPC_MAX_BLOCKS = 2000;

/** Blocks per eth_getLogs. Matches the literal both gap-fill call sites in
 * gapfill.ts pass, so heal ranges and fallback ranges chunk identically. */
export const HEAL_CHUNK_BLOCKS = 50;

/** Total budget for establishing `rpcHead >= to`, and the interval between
 * HTTP head reads inside it. */
export const RPC_HEAD_WAIT_MS = 15_000;
export const RPC_HEAD_POLL_MS = 1_000;

/**
 * Where the chain head comes from, in the order healRange asks.
 *
 * `cached` is the newest value the worker's blockNumber$ has produced. It
 * costs nothing, so it is always tried first — but it rides the WebSocket
 * provider, and 0.5.2 established that an ethers v6 WebSocketProvider can go
 * permanently silent without ever erroring. A stale cached head must never
 * turn every heal into a deferral, so a cached value BELOW the target is not
 * trusted as a refusal: the HTTP provider is asked directly.
 */
export interface RpcHeadSource {
  /** newest blockNumber$ value, or undefined if it has produced none */
  cached: () => number | undefined;
  /** one eth_blockNumber against the HTTP JSON-RPC provider */
  fetch: () => Promise<number>;
}

export type HealReason = 'gap' | 'reconcile';

export type HealResult =
  | {
      ok: true;
      events: NetworkComponentUpdate<Components>[];
      logs: number;
      ms: number;
      rpcHead: number | null;
      headSource: 'ws' | 'http' | null;
      chunks: number;
    }
  | {
      ok: false;
      deferred: 'rpc-head-behind' | 'torn-down';
      from: number;
      to: number;
      ms: number;
      rpcHead: number | null;
      headSource: 'ws' | 'http' | null;
    };

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/** The chunk boundaries healRange reads, identical to the ones
 * fetchEventsInBlockRangeChunked derives for the same inputs (asserted in
 * test/stream-heal.test.ts). Kept here so the loop can check the abort
 * signal BETWEEN chunks, which the ported helper has no parameter for. */
export function chunkRanges(from: number, to: number, interval: number): [number, number][] {
  const out: [number, number][] = [];
  if (to < from) return out;
  for (let f = from; f <= to; f += interval) {
    out.push([f, Math.min(f + interval - 1, to)]);
  }
  return out;
}

export interface HealRangeOptions {
  from: number;
  to: number;
  reason: HealReason;
  fetchWorldEvents: FetchWorldEvents;
  rpcHead: RpcHeadSource;
  /** the owning subscription's signal; a torn-down heal stops fetching */
  signal?: AbortSignal;
  chunkBlocks?: number;
  headWaitMs?: number;
  headPollMs?: number;
  /** annotation for the [heal] line when Kamigaze answered the wide part */
  path?: 'rpc' | 'kamigaze+rpc';
}

/**
 * Read [from, to] INCLUSIVE from the chain and return the events, or defer.
 *
 * Never partially applies: the caller gets either every event in the range
 * or none, and a deferral has already been recorded in `unhealedRanges`.
 */
export async function healRange(options: HealRangeOptions): Promise<HealResult> {
  const {
    from,
    to,
    reason,
    fetchWorldEvents,
    rpcHead,
    signal,
    chunkBlocks = HEAL_CHUNK_BLOCKS,
    headWaitMs = RPC_HEAD_WAIT_MS,
    headPollMs = RPC_HEAD_POLL_MS,
    path = 'rpc',
  } = options;
  const t0 = Date.now();

  // an empty range is a real, successful no-op — the common reconcile case
  if (to < from) {
    return { ok: true, events: [], logs: 0, ms: 0, rpcHead: null, headSource: null, chunks: 0 };
  }

  const head = await awaitRpcHead(to, rpcHead, { signal, headWaitMs, headPollMs });
  if (head === null) {
    const ms = Date.now() - t0;
    const deferred = signal?.aborted ? 'torn-down' : 'rpc-head-behind';
    recordUnhealed(from, to);
    syncHealth.gapsDeferred++;
    syncHealth.lastHealMs = ms;
    log.warn(
      `[heal] ${reason} ${from}..${to} DEFERRED (${deferred}) ms=${ms} — range recorded unhealed, nothing applied`
    );
    return { ok: false, deferred, from, to, ms, rpcHead: null, headSource: null };
  }

  const events: NetworkComponentUpdate<Components>[] = [];
  const chunks = chunkRanges(from, to, chunkBlocks);
  for (const [f, t] of chunks) {
    if (signal?.aborted) {
      const ms = Date.now() - t0;
      recordUnhealed(from, to);
      syncHealth.gapsDeferred++;
      syncHealth.lastHealMs = ms;
      log.warn(
        `[heal] ${reason} ${from}..${to} DEFERRED (torn-down) ms=${ms} — range recorded unhealed, nothing applied`
      );
      return { ok: false, deferred: 'torn-down', from, to, ms, rpcHead: head.blockNumber, headSource: head.source };
    }
    events.push(...((await fetchWorldEvents(f, t)) as NetworkComponentUpdate<Components>[]));
  }

  // the caller decides whether to APPLY these (it may have been torn down
  // while the last chunk was in flight); it calls settleHeal() when it does.
  const ms = Date.now() - t0;
  log.info(
    `[heal] ${reason} ${from}..${to} path=${path} logs=${events.length} ms=${ms} ` +
      `rpcHead=${head.blockNumber} src=${head.source} chunks=${chunks.length}`
  );
  return {
    ok: true,
    events,
    logs: events.length,
    ms,
    rpcHead: head.blockNumber,
    headSource: head.source,
    chunks: chunks.length,
  };
}

/** Book a completed heal whose events the caller actually applied. */
export function settleHeal(from: number, to: number, ms: number): void {
  syncHealth.gapsHealed++;
  syncHealth.lastHealMs = ms;
  clearUnhealed(from, to);
}

/** Book a heal whose events were discarded because the subscription went
 * away after the fetch landed (ruling (g)6: the range goes back on the
 * unhealed list so the next reconcile covers it). */
export function abandonHeal(from: number, to: number, ms: number): void {
  syncHealth.gapsDeferred++;
  syncHealth.lastHealMs = ms;
  recordUnhealed(from, to);
}

/**
 * Establish that the RPC node is at or past `to`.
 *
 * The cached blockNumber$ value is a FREE first check and is trusted only
 * when it already satisfies the target. Otherwise the HTTP provider is asked
 * directly, once per `headPollMs`, for at most `headWaitMs` — because a
 * cached head that is merely stale (a silent WebSocket, the 0.5.2 finding)
 * must not turn every heal into a deferral.
 */
export async function awaitRpcHead(
  to: number,
  rpcHead: RpcHeadSource,
  opts: { signal?: AbortSignal; headWaitMs?: number; headPollMs?: number } = {}
): Promise<{ blockNumber: number; source: 'ws' | 'http' } | null> {
  const { signal, headWaitMs = RPC_HEAD_WAIT_MS, headPollMs = RPC_HEAD_POLL_MS } = opts;
  if (signal?.aborted) return null;

  const cached = rpcHead.cached();
  if (cached !== undefined && cached >= to) return { blockNumber: cached, source: 'ws' };

  const deadline = Date.now() + headWaitMs;
  for (;;) {
    if (signal?.aborted) return null;
    try {
      const head = await rpcHead.fetch();
      if (head >= to) return { blockNumber: head, source: 'http' };
    } catch (e) {
      log.warn('[heal] eth_blockNumber failed while checking the head', e);
    }
    if (Date.now() >= deadline || signal?.aborted) return null;
    await sleep(headPollMs, signal);
  }
}
