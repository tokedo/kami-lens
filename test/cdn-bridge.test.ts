// Ported upstream suite (kami-lens 0.6.2 forward-port of
// Asphodel-OS/kamigotchi @ 21f419e6 — the CDN-to-live bridge).
// upstream path: packages/client/src/workers/sync/bridge.test.ts
// changes: imports re-pointed at the tsconfig aliases; the body is verbatim.
//
// The bridge reads an EMPTY streamer answer as "out of range". In the lens
// that inference has a second precondition upstream does not have, recorded
// in src/workers/sync/bridge.ts: parseGetEventsSinceResponse SKIPS an
// undecodable row, so the lens can answer SHORT rather than empty. Raised at
// the 0.6.2 gate 1 as a design question; not decided here.

import { describe, expect, it, vi } from 'vitest';

import { NetworkComponentUpdate, NetworkEvents } from 'workers/types';
import { bridgeBoot } from 'workers/sync/bridge';
import { createStateCache, StateCache } from 'workers/sync/state';

const FROM = 1000;
const STREAM_START = 1200;
const SNAPSHOT_HEAD = 1190;

const cacheAt = (block: number): StateCache => {
  const cache = createStateCache();
  cache.lastKamigazeBlock = block;
  return cache;
};

const event = {
  type: NetworkEvents.NetworkComponentUpdate,
} as unknown as NetworkComponentUpdate;

describe('bridgeBoot', () => {
  it('stops at the first streamer ask when it returns events', async () => {
    const cache = { current: cacheAt(FROM) };
    const gap = vi.fn(async () => [event]);
    const fetchDelta = vi.fn(async (c: StateCache) => c);

    const events = await bridgeBoot({ cache, toBlock: STREAM_START, gap, fetchDelta });

    expect(events).toEqual([event]);
    expect(gap).toHaveBeenCalledTimes(1);
    expect(gap).toHaveBeenCalledWith(FROM, true);
    expect(fetchDelta).not.toHaveBeenCalled();
  });

  it('asks the streamer again from the snapshot head after the delta', async () => {
    const cache = { current: cacheAt(FROM) };
    const delta = cacheAt(SNAPSHOT_HEAD);
    const gap = vi.fn(async (from: number) => (from === SNAPSHOT_HEAD ? [event] : []));
    const fetchDelta = vi.fn(async () => delta);

    const events = await bridgeBoot({ cache, toBlock: STREAM_START, gap, fetchDelta });

    expect(events).toEqual([event]);
    expect(fetchDelta).toHaveBeenCalledTimes(1);
    expect(cache.current).toBe(delta);
    expect(gap.mock.calls).toEqual([
      [FROM, true],
      [SNAPSHOT_HEAD, false],
    ]);
  });

  it('adopts the cache object the delta returns', async () => {
    const original = cacheAt(FROM);
    const cache = { current: original };
    const replacement = cacheAt(SNAPSHOT_HEAD);
    const gap = vi.fn(async () => []);
    const fetchDelta = vi.fn(async () => replacement);

    await bridgeBoot({ cache, toBlock: STREAM_START, gap, fetchDelta });

    expect(cache.current).toBe(replacement);
    expect(cache.current).not.toBe(original);
  });

  it('log-scans the full window when the delta throws', async () => {
    const original = cacheAt(FROM);
    const cache = { current: original };
    const gap = vi.fn(async (_from: number, skipRpcFallback: boolean) =>
      skipRpcFallback ? [] : [event]
    );
    const fetchDelta = vi.fn(async () => {
      throw new Error('snapshot down');
    });

    const events = await bridgeBoot({ cache, toBlock: STREAM_START, gap, fetchDelta });

    expect(events).toEqual([event]);
    expect(cache.current).toBe(original);
    expect(gap.mock.calls).toEqual([
      [FROM, true],
      [FROM, false],
    ]);
  });

  it('does not run the delta when the stream starts at the cached block', async () => {
    const cache = { current: cacheAt(FROM) };
    const gap = vi.fn(async () => []);
    const fetchDelta = vi.fn(async (c: StateCache) => c);

    const events = await bridgeBoot({ cache, toBlock: FROM, gap, fetchDelta });

    expect(events).toEqual([]);
    expect(gap).toHaveBeenCalledTimes(1);
    expect(fetchDelta).not.toHaveBeenCalled();
  });
});
