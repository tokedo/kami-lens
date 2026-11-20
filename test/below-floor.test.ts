// 1.2.0: below the endpoint's floor is never "no events".
//
// After the chain's return on 2026-11-20 the public endpoint serves no block,
// log, receipt or transaction below a floor (block 35,299,823 then):
// eth_getBlockByNumber answers null there, and eth_getLogs over a range that
// begins there answers an EMPTY list with HTTP 200 and no error — exactly what
// a range in which nothing happened answers. `eth_getBlockByNumber("earliest")`
// answers the HEAD, so the tag says nothing about the floor; it is found only
// by asking heights.
//
// The range reader asks the range's FIRST block and `latest` in the same batch
// as the logs (one backend). A first block that answers null while that
// backend serves a later head is below the floor: the read is marked
// `belowFloor` and proves nothing. healRange never accepts such a chunk: a gap
// heal defers (`below-floor`) and records the range unhealed; a reconcile or
// catch-up keeps only the prefix it proved before it and records the rest
// unhealed — which gates meta.stale. At boot, a cache or a CDN image whose
// window would begin below the floor is loaded cold instead (probeFloor).
//
// Every block number and log here is synthetic.

import { beforeEach, describe, expect, it } from 'vitest';

import { resetSyncHealth, syncHealth } from '../src/sync-health';
import { healRange } from 'workers/sync/stream/heal';
import { isBelowFloor, probeFloor } from 'workers/sync/utils';
import { type ChainLog, poolProvider, reader } from './support/chain';

const HEAD = 2_000;
const FLOOR = 1_000;

/** one write every 10 blocks from 900, by two transactions in turn */
const CHAIN: ChainLog[] = Array.from({ length: 30 }, (_, i) => ({
  block: 900 + i * 10,
  tx: i % 2,
  logIndex: 0,
  entity: BigInt(0xa0 + (i % 5)),
  value: [i],
}));

const provider = (floor = FLOOR) => poolProvider(CHAIN, { single: () => HEAD, batch: () => HEAD }, floor);
const rpcHead = { cached: () => HEAD, fetch: async () => HEAD };

beforeEach(() => resetSyncHealth());

describe('the range reader knows the floor', () => {
  it('a range wholly below the floor answers EMPTY — and is marked belowFloor, proving nothing', async () => {
    const r = await reader(provider())(900, 949);
    expect(r).toHaveLength(0); // the endpoint's silent answer
    expect(r.belowFloor).toBe(true);
    expect(r.provenThrough).toBe(899);
  });

  it('a range that straddles the floor is marked too: its logs above the floor are not the whole range', async () => {
    const r = await reader(provider())(980, 1_029);
    expect(r.map((e) => e.blockNumber)).toEqual([1_000, 1_010, 1_020]);
    expect(r.belowFloor).toBe(true);
    expect(r.provenThrough).toBe(979);
  });

  it('a range that begins at the floor proves itself as before', async () => {
    const r = await reader(provider())(1_000, 1_049);
    expect(r.belowFloor).toBeUndefined();
    expect(r.provenThrough).toBe(1_049);
    expect(r).toHaveLength(5);
  });

  it('never asks the `earliest` tag (the endpoint answers it with the head)', async () => {
    const p = provider();
    const sent: unknown[] = [];
    const send = p._send;
    p._send = async (payload: unknown) => {
      sent.push(payload);
      return send(payload);
    };
    await reader(p)(900, 949);
    await probeFloor(p as never, 950);
    expect(JSON.stringify(sent)).not.toContain('earliest');
  });

  it('isBelowFloor: null first block AND a later served head; a lagging backend is not the floor', () => {
    expect(isBelowFloor(950, null, { number: '0x7d0' })).toBe(true);
    expect(isBelowFloor(950, { number: '0x3b6' }, { number: '0x7d0' })).toBe(false);
    // the backend's own head is below the block: it is behind, not floored
    expect(isBelowFloor(2_100, null, { number: '0x7d0' })).toBe(false);
    expect(isBelowFloor(950, null, null)).toBe(false);
  });
});

describe('healRange: a chunk below the floor is never healed or reconciled on its empty answer', () => {
  it('a GAP heal that begins below the floor defers `below-floor` and records the range unhealed', async () => {
    const r = await healRange({ from: 950, to: 1_049, reason: 'gap', fetchWorldEvents: reader(provider()), rpcHead, headWaitMs: 50, headPollMs: 5 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.deferred).toBe('below-floor');
    expect(syncHealth.unhealedRanges).toEqual([[950, 1_049]]);
    expect(syncHealth.gapsDeferred).toBe(1);
  });

  it('a RECONCILE that begins below the floor proves nothing and leaves [from, to] unhealed', async () => {
    const r = await healRange({ from: 950, to: 1_100, reason: 'reconcile', fetchWorldEvents: reader(provider()), rpcHead, partial: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provenThrough).toBe(949);
    expect(r.events).toEqual([]);
    expect(syncHealth.unhealedRanges).toEqual([[950, 1_100]]);
  });

  it('a catch-up likewise', async () => {
    const r = await healRange({ from: 990, to: 1_020, reason: 'catch-up', fetchWorldEvents: reader(provider()), rpcHead, partial: true });
    expect(r.ok && r.provenThrough).toBe(989);
    expect(syncHealth.unhealedRanges).toEqual([[990, 1_020]]);
  });

  it('with no floor the same reads heal and reconcile as before (the guard is the floor, not the range)', async () => {
    const gap = await healRange({ from: 950, to: 1_049, reason: 'gap', fetchWorldEvents: reader(provider(0)), rpcHead, headWaitMs: 50, headPollMs: 5 });
    expect(gap.ok).toBe(true);
    const rec = await healRange({ from: 950, to: 1_100, reason: 'reconcile', fetchWorldEvents: reader(provider(0)), rpcHead, partial: true });
    expect(rec.ok && rec.provenThrough).toBe(1_100);
    expect(syncHealth.unhealedRanges).toEqual([]);
  });
});

describe('probeFloor (the boot\'s question)', () => {
  it('below / served / unknown', async () => {
    expect(await probeFloor(provider() as never, 999)).toBe('below');
    expect(await probeFloor(provider() as never, 1_000)).toBe('served');
    expect(await probeFloor(undefined, 999)).toBe('unknown');
    expect(await probeFloor({} as never, 999)).toBe('unknown');
    // a block above every head is unknown, not below
    expect(await probeFloor(provider() as never, 5_000)).toBe('unknown');
  });
});
