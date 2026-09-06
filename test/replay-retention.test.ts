import { describe, expect, it } from 'vitest';

import {
  RETENTION_BLOCKS,
  ReplayRetentionError,
  replayOnto,
} from '../gates/g1/lib.mts';

// Gate-library unit, DESIGN §4.1 / SPEC §2 (0.6.1).
//
// eth_getLogs on the public Yominet endpoint answers an EMPTY result with
// HTTP 200 beyond its ~1.02 M-block retention window — not an error. A replay
// over a pruned range therefore fetches nothing, stamps the cache at toBlock
// anyway, and hands every downstream gate a mirror with a silent hole in it.
// On 2026-09-06 the shared c2.v8snap fixture sat 1,207,995 blocks behind head
// and a probe of the 200 blocks after the fixture's own block returned zero
// logs (docs/measurements/fixture-retention-2026-09-06.json). The guard turns
// that into a named refusal.
//
// Hermetic: a fake cache, a fake fetcher that records the ranges it was asked
// for, and a fake provider. No network.

const HEAD = 33_000_000;

type Fake = {
  cache: { blockNumber: number; state: Map<unknown, unknown> } & Record<string, unknown>;
  ranges: [number, number][];
  fetchWorldEvents: unknown;
  provider: { getBlockNumber: () => Promise<number> };
};

function fake(cacheBlock: number, head = HEAD): Fake {
  const ranges: [number, number][] = [];
  return {
    // replayOnto only reads/writes blockNumber and passes the cache to
    // storeStateEvents, which is a no-op for an empty event list
    cache: { blockNumber: cacheBlock, state: new Map() } as never,
    ranges,
    fetchWorldEvents: (async (from: number, to: number) => {
      ranges.push([from, to]);
      return [];
    }) as never,
    provider: { getBlockNumber: async () => head },
  };
}

describe('replayOnto retention guard (§4.1, 0.6.1)', () => {
  it('refuses a range that starts beyond the retention horizon, and fetches nothing', async () => {
    const f = fake(HEAD - RETENTION_BLOCKS - 50_000);
    await expect(
      replayOnto(f.cache as never, f.fetchWorldEvents as never, HEAD - 10, {
        provider: f.provider as never,
      })
    ).rejects.toBeInstanceOf(ReplayRetentionError);
    // the point of refusing: no partial mirror was built
    expect(f.ranges).toEqual([]);
  });

  it('names both numbers and the horizon in the refusal', async () => {
    const from = HEAD - RETENTION_BLOCKS - 50_000;
    const f = fake(from - 1);
    const err = await replayOnto(f.cache as never, f.fetchWorldEvents as never, HEAD - 10, {
      provider: f.provider as never,
    }).catch((e: unknown) => e as ReplayRetentionError);
    expect(err).toBeInstanceOf(ReplayRetentionError);
    const e = err as ReplayRetentionError;
    expect(e.detail.blocksBehindHead).toBe(HEAD - from);
    expect(e.detail.retentionBlocks).toBe(RETENTION_BLOCKS);
    expect(e.detail.head).toBe(HEAD);
    expect(e.detail.reason).toContain('STARTS beyond');
    expect(e.message).toContain(String(RETENTION_BLOCKS));
    expect(e.message).toContain('EMPTY with HTTP 200');
  });

  it('catches the SHORT-span pruned replay a span check would miss', async () => {
    // This is the G2.b/G3.c shape and the whole reason the predicate is
    // head - fromBlock and not toBlock - fromBlock: a 10k-block replay whose
    // BOTH ends are ~1.8M blocks behind head. The span is tiny and every log
    // in it is pruned.
    const base = HEAD - 1_800_000;
    const f = fake(base);
    const err = await replayOnto(f.cache as never, f.fetchWorldEvents as never, base + 10_000, {
      provider: f.provider as never,
    }).catch((e: unknown) => e as ReplayRetentionError);
    expect(err).toBeInstanceOf(ReplayRetentionError);
    expect((err as ReplayRetentionError).detail.spanBlocks).toBe(10_000);
    expect((err as ReplayRetentionError).detail.spanBlocks).toBeLessThan(RETENTION_BLOCKS);
    expect(f.ranges).toEqual([]);
  });

  it('refuses a span longer than the whole window even with no provider', async () => {
    const f = fake(1_000);
    await expect(
      replayOnto(f.cache as never, f.fetchWorldEvents as never, 1_000 + RETENTION_BLOCKS + 5)
    ).rejects.toBeInstanceOf(ReplayRetentionError);
    expect(f.ranges).toEqual([]);
  });

  it('allows a range fully inside the window and stamps the cache at toBlock', async () => {
    const f = fake(HEAD - 5_000);
    await replayOnto(f.cache as never, f.fetchWorldEvents as never, HEAD - 8, {
      provider: f.provider as never,
    });
    expect(f.ranges.length).toBeGreaterThan(0);
    expect(f.ranges[0]![0]).toBe(HEAD - 5_000 + 1);
    expect(f.ranges[f.ranges.length - 1]![1]).toBe(HEAD - 8);
    expect(f.cache.blockNumber).toBe(HEAD - 8);
  });

  it('allows a range sitting exactly ON the horizon (the boundary is not off by one)', async () => {
    const f = fake(HEAD - RETENTION_BLOCKS - 1); // fromBlock = head - RETENTION
    await replayOnto(f.cache as never, f.fetchWorldEvents as never, HEAD - 8, {
      provider: f.provider as never,
    });
    expect(f.cache.blockNumber).toBe(HEAD - 8);
  });

  it('still no-ops backward without consulting the provider', async () => {
    let asked = 0;
    const f = fake(HEAD - 10);
    const provider = {
      getBlockNumber: async () => {
        asked++;
        return HEAD;
      },
    };
    await replayOnto(f.cache as never, f.fetchWorldEvents as never, HEAD - 50, {
      provider: provider as never,
    });
    expect(asked).toBe(0);
    expect(f.ranges).toEqual([]);
    expect(f.cache.blockNumber).toBe(HEAD - 10);
  });

  it('honours an explicit retentionBlocks override (G1.f re-measures it)', async () => {
    const f = fake(HEAD - 500);
    await expect(
      replayOnto(f.cache as never, f.fetchWorldEvents as never, HEAD - 8, {
        provider: f.provider as never,
        retentionBlocks: 100,
      })
    ).rejects.toBeInstanceOf(ReplayRetentionError);
  });
});
