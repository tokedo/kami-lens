import { describe, expect, it, vi } from 'vitest';

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
