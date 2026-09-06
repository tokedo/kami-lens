import { describe, expect, it } from 'vitest';

import { Components } from 'engine/recs';
import { NetworkComponentUpdate, NetworkEvents } from 'workers/types';
import { fetchEventsInBlockRangeChunked } from 'workers/sync/utils';

// 0.6.0 (DESIGN §3.17, L-1) — chain-authoritative gap recovery. The whole
// recovery path was hermetically untested before this file: no test imported
// createStream, fetchGapEvents or fetchEventsInBlockRangeChunked, and G8.a
// could only grep container logs for which branch ran. Everything here is
// fakes and fake timers; the live half is G8.b.

// --------------------------------------------------------------- fakes ----

/** Records every [from, to] it is asked for, in call order, and answers with
 * one event per requested block stamped `blockNumber = to` — the same stamp
 * createFetchWorldEventsInBlockRange applies (workers/sync/utils.ts). */
export function makeFetchWorldEvents(options: { stallMs?: number; empty?: boolean } = {}) {
  const ranges: [number, number][] = [];
  let stallMs = options.stallMs ?? 0;
  const fn = async (from: number, to: number) => {
    ranges.push([from, to]);
    if (stallMs > 0) await new Promise((r) => setTimeout(r, stallMs));
    if (options.empty) return [];
    const out: NetworkComponentUpdate<Components>[] = [];
    for (let b = from; b <= to; b++) {
      out.push({
        type: NetworkEvents.NetworkComponentUpdate,
        component: '0xcomp',
        entity: `0x${b.toString(16)}`,
        value: undefined,
        blockNumber: to,
        lastEventInTx: true,
        txHash: `0xtx${b}`,
      } as unknown as NetworkComponentUpdate<Components>);
    }
    return out;
  };
  return Object.assign(fn, {
    ranges,
    setStall: (ms: number) => {
      stallMs = ms;
    },
  });
}

// ------------------------------------------------- 1. chunked range fetch --

describe('fetchEventsInBlockRangeChunked — a non-negative range always fetches', () => {
  it('from === to fetches exactly that one block (the same-block gap)', async () => {
    const fetchWorldEvents = makeFetchWorldEvents();
    const events = await fetchEventsInBlockRangeChunked(fetchWorldEvents, 100, 100, 50);
    expect(fetchWorldEvents.ranges).toEqual([[100, 100]]);
    expect(events).toHaveLength(1);
    expect(events[0]!.blockNumber).toBe(100);
  });

  it('an inclusive span of exactly `interval` blocks is one chunk', async () => {
    const fetchWorldEvents = makeFetchWorldEvents();
    await fetchEventsInBlockRangeChunked(fetchWorldEvents, 100, 149, 50);
    expect(fetchWorldEvents.ranges).toEqual([[100, 149]]);
  });

  it('chunks at `interval` and the last chunk ends exactly at `to`', async () => {
    const fetchWorldEvents = makeFetchWorldEvents();
    await fetchEventsInBlockRangeChunked(fetchWorldEvents, 100, 220, 50);
    expect(fetchWorldEvents.ranges).toEqual([
      [100, 149],
      [150, 199],
      [200, 220],
    ]);
    // every block in [100, 220] is covered exactly once, no hole, no overlap
    const covered = new Set<number>();
    for (const [f, t] of fetchWorldEvents.ranges) {
      for (let b = f; b <= t; b++) {
        expect(covered.has(b)).toBe(false);
        covered.add(b);
      }
    }
    expect(covered.size).toBe(121);
  });

  it('a negative range fetches nothing', async () => {
    const fetchWorldEvents = makeFetchWorldEvents();
    const events = await fetchEventsInBlockRangeChunked(fetchWorldEvents, 200, 199, 50);
    expect(fetchWorldEvents.ranges).toEqual([]);
    expect(events).toEqual([]);
  });

  it('never reports a non-finite percentage (§3.14 — it reaches LoadingState)', async () => {
    const seen: number[] = [];
    const fetchWorldEvents = makeFetchWorldEvents();
    await fetchEventsInBlockRangeChunked(fetchWorldEvents, 100, 100, 50, (p) => seen.push(p));
    await fetchEventsInBlockRangeChunked(fetchWorldEvents, 100, 220, 50, (p) => seen.push(p));
    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen) {
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(100);
    }
  });
});

// ------------------------------------------------- 2. the heal primitive --

import {
  GAP_RPC_MAX_BLOCKS,
  HEAL_CHUNK_BLOCKS,
  abandonHeal,
  awaitRpcHead,
  chunkRanges,
  healRange,
  settleHeal,
} from 'workers/sync/stream/heal';
import {
  recordUnhealed,
  resetSyncHealth,
  syncHealth,
  syncHealthReport,
  unhealedForMs,
} from '../src/sync-health';

const recordAt = (from: number, to: number, now: number) => recordUnhealed(from, to, now);

/** cached = what blockNumber$ last produced (free, possibly stale);
 *  fetch  = one eth_blockNumber against the HTTP provider. */
function makeRpcHead(script: { cached?: number | undefined; http?: number[] } = {}) {
  const http = [...(script.http ?? [])];
  let httpCalls = 0;
  return {
    cached: () => script.cached,
    fetch: async () => {
      httpCalls++;
      return http.length > 1 ? http.shift()! : (http[0] ?? 0);
    },
    get httpCalls() {
      return httpCalls;
    },
  };
}

const fast = { headWaitMs: 40, headPollMs: 5 } as const;

describe('healRange — the one recovery primitive', () => {
  it('its chunk boundaries are the ported chunker s boundaries', async () => {
    for (const [from, to] of [
      [100, 100],
      [100, 149],
      [100, 150],
      [100, 220],
      [1000, 2999],
    ] as [number, number][]) {
      const fetchWorldEvents = makeFetchWorldEvents();
      await fetchEventsInBlockRangeChunked(fetchWorldEvents, from, to, HEAL_CHUNK_BLOCKS);
      expect(chunkRanges(from, to, HEAL_CHUNK_BLOCKS)).toEqual(fetchWorldEvents.ranges);
    }
  });

  it('an empty range is a successful no-op and reads nothing', async () => {
    resetSyncHealth();
    const fetchWorldEvents = makeFetchWorldEvents();
    const rpcHead = makeRpcHead({ cached: 10 });
    const r = await healRange({ from: 200, to: 199, reason: 'reconcile', fetchWorldEvents, rpcHead });
    expect(r.ok).toBe(true);
    expect(fetchWorldEvents.ranges).toEqual([]);
    expect(rpcHead.httpCalls).toBe(0);
    expect(syncHealth.gapsDeferred).toBe(0);
  });

  it('a cached head at or past `to` is used, and costs no RPC call', async () => {
    resetSyncHealth();
    const fetchWorldEvents = makeFetchWorldEvents();
    const rpcHead = makeRpcHead({ cached: 500, http: [500] });
    const r = await healRange({ from: 100, to: 100, reason: 'gap', fetchWorldEvents, rpcHead, ...fast });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.headSource).toBe('ws');
    expect(rpcHead.httpCalls).toBe(0);
    expect(fetchWorldEvents.ranges).toEqual([[100, 100]]);
  });

  it('a STALE cached head below `to` is not trusted as a refusal — HTTP decides', async () => {
    resetSyncHealth();
    const fetchWorldEvents = makeFetchWorldEvents();
    // blockNumber$ wedged at 90 (a silent WebSocket); the chain is really at 500
    const rpcHead = makeRpcHead({ cached: 90, http: [500] });
    const r = await healRange({ from: 100, to: 100, reason: 'gap', fetchWorldEvents, rpcHead, ...fast });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.headSource).toBe('http');
    expect(rpcHead.httpCalls).toBe(1);
    expect(fetchWorldEvents.ranges).toEqual([[100, 100]]);
  });

  it('rpcHead below `to` for the whole budget defers: nothing fetched, range recorded', async () => {
    resetSyncHealth();
    const fetchWorldEvents = makeFetchWorldEvents();
    const rpcHead = makeRpcHead({ cached: 90, http: [90] });
    const r = await healRange({ from: 100, to: 120, reason: 'gap', fetchWorldEvents, rpcHead, ...fast });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.deferred).toBe('rpc-head-behind');
    expect(fetchWorldEvents.ranges).toEqual([]);
    expect(rpcHead.httpCalls).toBeGreaterThan(1);
    expect(syncHealthReport().unhealedRanges).toEqual([[100, 120]]);
    expect(syncHealth.gapsDeferred).toBe(1);
  });

  it('a head that catches up inside the budget heals', async () => {
    resetSyncHealth();
    const fetchWorldEvents = makeFetchWorldEvents();
    const rpcHead = makeRpcHead({ cached: undefined, http: [90, 95, 130] });
    const r = await healRange({ from: 100, to: 120, reason: 'reconcile', fetchWorldEvents, rpcHead, ...fast });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rpcHead).toBe(130);
    expect(fetchWorldEvents.ranges).toEqual([[100, 120]]);
  });

  it('an abort mid-heal stops fetching, applies nothing, and records the range', async () => {
    resetSyncHealth();
    const ac = new AbortController();
    const fetchWorldEvents = makeFetchWorldEvents();
    // abort as soon as the first chunk has been requested
    const wrapped = Object.assign(
      async (f: number, t: number) => {
        const out = await fetchWorldEvents(f, t);
        ac.abort();
        return out;
      },
      { ranges: fetchWorldEvents.ranges }
    );
    const rpcHead = makeRpcHead({ cached: 10_000 });
    const r = await healRange({
      from: 100,
      to: 220,
      reason: 'gap',
      fetchWorldEvents: wrapped as never,
      rpcHead,
      signal: ac.signal,
      ...fast,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.deferred).toBe('torn-down');
    // stopped after the first chunk rather than reading all three
    expect(fetchWorldEvents.ranges).toEqual([[100, 149]]);
    expect(syncHealthReport().unhealedRanges).toEqual([[100, 220]]);
  });

  it('an already-aborted signal defers before any read', async () => {
    resetSyncHealth();
    const ac = new AbortController();
    ac.abort();
    const fetchWorldEvents = makeFetchWorldEvents();
    const rpcHead = makeRpcHead({ cached: 10_000 });
    const r = await healRange({
      from: 100,
      to: 120,
      reason: 'gap',
      fetchWorldEvents,
      rpcHead,
      signal: ac.signal,
      ...fast,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.deferred).toBe('torn-down');
    expect(fetchWorldEvents.ranges).toEqual([]);
  });

  it('awaitRpcHead reports which source answered', async () => {
    expect(await awaitRpcHead(100, makeRpcHead({ cached: 100 }), fast)).toEqual({
      blockNumber: 100,
      source: 'ws',
    });
    expect(await awaitRpcHead(100, makeRpcHead({ cached: 1, http: [200] }), fast)).toEqual({
      blockNumber: 200,
      source: 'http',
    });
    expect(await awaitRpcHead(100, makeRpcHead({ cached: 1, http: [1] }), fast)).toBeNull();
  });

  it('GAP_RPC_MAX_BLOCKS is the documented 2000 (~40 chunked calls)', () => {
    expect(GAP_RPC_MAX_BLOCKS).toBe(2000);
    expect(Math.ceil(GAP_RPC_MAX_BLOCKS / HEAL_CHUNK_BLOCKS)).toBe(40);
  });
});

describe('sync-health bookkeeping', () => {
  it('settleHeal clears the ranges it covered; abandonHeal puts one back', () => {
    resetSyncHealth();
    abandonHeal(100, 120, 5);
    abandonHeal(400, 420, 5);
    expect(syncHealthReport().unhealedRanges).toEqual([
      [100, 120],
      [400, 420],
    ]);
    settleHeal(90, 200, 7);
    expect(syncHealthReport().unhealedRanges).toEqual([[400, 420]]);
    expect(syncHealth.gapsHealed).toBe(1);
    expect(syncHealth.gapsDeferred).toBe(2);
  });

  it('a partially covering heal trims rather than drops', () => {
    resetSyncHealth();
    abandonHeal(100, 200, 1);
    settleHeal(150, 400, 1);
    expect(syncHealthReport().unhealedRanges).toEqual([[100, 149]]);
  });

  it('adjacent and overlapping deferrals merge', () => {
    resetSyncHealth();
    abandonHeal(100, 120, 1);
    abandonHeal(121, 140, 1);
    abandonHeal(110, 130, 1);
    expect(syncHealthReport().unhealedRanges).toEqual([[100, 140]]);
  });

  it('unhealedForMs measures from the moment the list went non-empty', () => {
    resetSyncHealth();
    expect(unhealedForMs(1_000)).toBe(0);
    recordAt(100, 120, 1_000);
    expect(unhealedForMs(3_500)).toBe(2_500);
    settleHeal(100, 120, 1);
    expect(unhealedForMs(9_999)).toBe(0);
  });

  it('the report is a copy — a caller cannot mutate the counters', () => {
    resetSyncHealth();
    abandonHeal(1, 2, 1);
    const report = syncHealthReport();
    report.unhealedRanges[0]![0] = 999;
    report.gapsHealed = 999;
    expect(syncHealth.unhealedRanges[0]![0]).toBe(1);
    expect(syncHealth.gapsHealed).toBe(0);
  });
});
