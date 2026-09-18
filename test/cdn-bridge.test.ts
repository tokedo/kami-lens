// The CDN-to-live bridge. Ported from Asphodel-OS/kamigotchi @ 21f419e6
// (upstream path: packages/client/src/workers/sync/bridge.test.ts) and then
// REWRITTEN for divergence 12, because the lens's bridge is delta-first where
// upstream's is streamer-first.
//
// Upstream's suite asserted the inference this release rejects: that the
// streamer is asked first with the RPC fallback OFF, and that an EMPTY answer
// means "out of range" and is what triggers the snapshot delta. In the lens
// "empty" conflates four facts — refused, threw-and-was-swallowed, genuinely
// empty, and SHORT (the port skips an undecodable row where upstream aborts) —
// and the whole bridge window sits BELOW the reconcile baseline seeded right
// after it, where every reconcile tick is a counted no-op by design. A short
// answer would therefore land the daemon LIVE with `degraded: []` over a
// permanent hole: the 2026-09-06 L-1 class. The full argument is in
// src/workers/sync/bridge.ts's banner.
//
// So these tests assert the opposite ordering, and one property that is not
// about ordering at all: that no call on this path can be told to skip the RPC
// fallback, which is structural — `gap` takes one argument.

import { describe, expect, it, vi } from 'vitest';

import { bridgeBoot } from 'workers/sync/bridge';
import { createStateCache, StateCache } from 'workers/sync/state';
import { NetworkComponentUpdate, NetworkEvents } from 'workers/types';

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

describe('bridgeBoot — delta-first (divergence 12)', () => {
  it('runs the delta ALWAYS, then gap-fills from the delta head', async () => {
    const cache = { current: cacheAt(FROM) };
    const delta = cacheAt(SNAPSHOT_HEAD);
    const gap = vi.fn(async () => [event]);
    const fetchDelta = vi.fn(async () => delta);

    const events = await bridgeBoot({ cache, toBlock: STREAM_START, gap, fetchDelta });

    expect(events).toEqual([event]);
    expect(fetchDelta).toHaveBeenCalledTimes(1);
    // the gap-fill covers only the snapshot service's sync period
    expect(gap.mock.calls).toEqual([[SNAPSHOT_HEAD]]);
  });

  it('runs the delta even when the streamer would have answered the window', async () => {
    // THE WHOLE POINT OF THE DIVERGENCE. Upstream stops here and never calls
    // fetchDelta, because a non-empty first answer satisfies it. It cannot
    // know whether that answer was complete, and the delta is the only thing
    // that carries the CDN image forward over STATE rows (values, removals,
    // entities) rather than events.
    const cache = { current: cacheAt(FROM) };
    const delta = cacheAt(SNAPSHOT_HEAD);
    const gap = vi.fn(async () => [event, event]);
    const fetchDelta = vi.fn(async () => delta);

    await bridgeBoot({ cache, toBlock: STREAM_START, gap, fetchDelta });

    expect(fetchDelta).toHaveBeenCalledTimes(1);
    expect(cache.current).toBe(delta);
  });

  it('runs the delta even when the stream starts at the cached block', async () => {
    // upstream skips it on `toBlock > from`; here the delta is unconditional,
    // because the snapshot service can hold rows the exporter's image does not
    // whatever the stream's start block happens to be
    const cache = { current: cacheAt(FROM) };
    const gap = vi.fn(async () => []);
    const fetchDelta = vi.fn(async (c: StateCache) => c);

    const events = await bridgeBoot({ cache, toBlock: FROM, gap, fetchDelta });

    expect(events).toEqual([]);
    expect(fetchDelta).toHaveBeenCalledTimes(1);
    expect(gap.mock.calls).toEqual([[FROM]]);
  });

  it('adopts the cache object the delta returns', async () => {
    // a nonce mismatch makes fetchSnapshot full-reload into a NEW cache and
    // return it; keeping the old object would silently discard that load
    const original = cacheAt(FROM);
    const cache = { current: original };
    const replacement = cacheAt(SNAPSHOT_HEAD);
    const gap = vi.fn(async () => []);
    const fetchDelta = vi.fn(async () => replacement);

    await bridgeBoot({ cache, toBlock: STREAM_START, gap, fetchDelta });

    expect(cache.current).toBe(replacement);
    expect(cache.current).not.toBe(original);
  });

  it('gap-fills the FULL window when the delta throws, and keeps the cache', async () => {
    const original = cacheAt(FROM);
    const cache = { current: original };
    const gap = vi.fn(async () => [event]);
    const fetchDelta = vi.fn(async () => {
      throw new Error('snapshot down');
    });

    const events = await bridgeBoot({ cache, toBlock: STREAM_START, gap, fetchDelta });

    expect(events).toEqual([event]);
    // slow but chain-authoritative — the property that matters when the
    // snapshot service is the thing that just failed
    expect(gap.mock.calls).toEqual([[FROM]]);
    expect(cache.current).toBe(original);
  });

  it('asks the gap-fill exactly once, and never tells it to skip the RPC fallback', async () => {
    // Structural, not behavioural: `gap` takes ONE argument, so there is no
    // skipRpcFallback to pass. Asserted anyway, because the flag existing at
    // all is what let upstream's [] mean four different things, and a future
    // edit that reintroduced it would fail here rather than in production.
    const cache = { current: cacheAt(FROM) };
    const gap = vi.fn(async () => []);
    const fetchDelta = vi.fn(async () => cacheAt(SNAPSHOT_HEAD));

    await bridgeBoot({ cache, toBlock: STREAM_START, gap, fetchDelta });

    expect(gap).toHaveBeenCalledTimes(1);
    expect(gap.mock.calls[0]).toHaveLength(1);
  });
});
