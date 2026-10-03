// A1 — the post-stall clock rule (src/daemon.ts syncClock).
//
// The projection clock is re-anchored every 300 s on the header time of the
// newest block the stream delivered. Across a stream stall that block is
// frozen, so each tick re-observed the SAME old header against a later wall
// time: now() was pinned to the frozen block's timestamp and every projection
// computed on a past instant, by up to the length of the stall. A sample is
// now taken only on a block newer than the previous sample's.

import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import * as clock from 'clock';
import { KamiLensDaemon } from '../src/daemon';

type Internals = {
  liveBlockNumber: number;
  clockProvider: { getBlock: (n: number) => Promise<{ timestamp: number } | null> };
  syncClock: () => Promise<void>;
};

afterEach(() => clock.reset());

describe('A1: the clock is never re-anchored on a frozen block', () => {
  it('a stalled stream keeps wall time + the last offset instead of pinning now() to the frozen block', async () => {
    const d = new KamiLensDaemon({ dataDir: path.join(os.tmpdir(), 'kami-lens-clock-void') });
    const internals = d as unknown as Internals;
    const headerTime = Math.floor(Date.now() / 1000) - 10; // a block 10 s old
    const asked: number[] = [];
    internals.clockProvider = {
      getBlock: async (n) => {
        asked.push(n);
        return { timestamp: headerTime };
      },
    };

    internals.liveBlockNumber = 1_000;
    await internals.syncClock();
    expect(clock.lastObservation()?.blockNumber).toBe(1_000);
    const offsetAfterFirst = clock.offset();

    // the stream stalls; 300 s later the tick comes round on the SAME block.
    // Re-observing it would set offset = header - (wall now), i.e. walk the
    // clock back by every second of the stall.
    await internals.syncClock();
    expect(asked).toEqual([1_000]); // not even asked
    expect(clock.offset()).toBe(offsetAfterFirst);

    // the stream recovers: a newer block is sampled
    internals.liveBlockNumber = 1_005;
    await internals.syncClock();
    expect(asked).toEqual([1_000, 1_005]);
    expect(clock.lastObservation()?.blockNumber).toBe(1_005);
  });
});
