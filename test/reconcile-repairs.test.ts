// 1.0.1 — the reconcile-repair tripwire (status.sync.reconcileRepairs /
// lastRepair), so the next write the mirror misses is not found by a player.
//
// A REPAIR is a write from the PERIODIC reconcile — not a gap heal, not a
// catch-up, not the boot window over position-less data — that the guard
// applied AND that changed the mirror's value, for a block strictly below
// the stream cursor as it stood when that pass started. On a healthy stream
// the count stays 0: the stream already applied every write of every block
// it has moved past. The cursor's own block is excluded because the stream
// may still be inside it. Each repair is one WARN line; none sets `degraded`.

import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDecode } from 'engine/encoders';
import { Components, createWorld, getComponentValue } from 'engine/recs';
import { formatComponentID, formatEntityID } from 'engine/utils';
import { createComponents } from 'network/components';
import { applyNetworkUpdates } from 'network/setup';
import { sameComponentValue } from 'network/setup/utils';
import { resetSyncHealth, syncHealth, syncHooks } from '../src/sync-health';
import { log } from 'utils/logger';
import { Ack } from 'workers/sync';
import { createStream, markerEvent } from 'workers/sync/stream';
import { NetworkEvent } from 'workers/types';
import {
  COMPONENT_ID,
  emptyFrame,
  framesFor,
  poolProvider,
  reader,
  scriptedClient,
  WORLD,
  type ChainLog,
} from './support/chain';

const COMPONENT = formatComponentID(COMPONENT_ID);
const E1 = 0xe1n;
const E2 = 0xe2n;

function harness(chain: ChainLog[], frames: Parameters<typeof scriptedClient>[0], head: number) {
  const world = createWorld();
  const components = createComponents(world);
  const ecsEvents$ = new Subject<NetworkEvent[]>();
  applyNetworkUpdates(
    world,
    components,
    ecsEvents$ as never,
    { [COMPONENT]: 'Value' } as Record<string, keyof Components> as never,
    new Subject<Ack>()
  );
  const value = (e: bigint) => {
    const idx = world.entityToIndex.get(formatEntityID(`0x${e.toString(16)}`));
    return idx === undefined ? undefined : getComponentValue(components.Value, idx)?.value;
  };
  const reconcileFrom$ = new Subject<{ baseline: number; frontier: number }>();
  let empties = 0;
  const sub = createStream({
    url: 'http://fake',
    worldAddress: WORLD,
    decode: createDecode(),
    includeSystemCalls: false,
    fetchWorldEvents: reader(poolProvider(chain, { single: () => head, batch: () => head })),
    rpcHead: { cached: () => head, fetch: async () => head },
    createClient: () => scriptedClient(frames),
    timeoutMs: 30_000,
    reconcileFrom$,
    reconcileIntervalMs: 60_000, // passes run only when the test seeds one
    reconcileCatchUpGapMs: 5,
    reconcilePaceMs: 0,
    headWaitMs: 50,
    headPollMs: 5,
  }).subscribe((e) => {
    if ((e as { txHash?: string }).txHash === 'EmptyNetworkEvent') empties++;
    ecsEvents$.next([e as NetworkEvent]);
  });
  const stop = () => {
    sub.unsubscribe();
    world.dispose();
  };
  return { value, reconcileFrom$, stop, apply: (e: unknown) => ecsEvents$.next([e as NetworkEvent]), empties: () => empties };
}

async function until(cond: () => boolean, ms = 2_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const deferred = () => {
  let release!: () => void;
  const p = new Promise<void>((r) => (release = r));
  return { p, release };
};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetSyncHealth();
  warn = vi.spyOn(log, 'warn');
});
afterEach(() => warn.mockRestore());
const repairLines = () =>
  warn.mock.calls.filter((c: unknown[]) => /reconcile REPAIRED/.test(String(c[0]))).length;

describe('a repair is a periodic-reconcile write below the stream cursor that changed the mirror', () => {
  it('counts one: the stream lost a write of block B and moved on; the reconcile restores it — one WARN line', async () => {
    const B = 900;
    const chain: ChainLog[] = [
      { block: B, tx: 1, logIndex: 1, entity: E1, value: [1] },
      { block: B, tx: 2, logIndex: 1, entity: E1, value: [2] }, // lost by the stream, unseen
      { block: B, tx: 2, logIndex: 2, entity: E2, value: [5] },
    ];
    // the server never sent tx 2's first log, and chained the rest as if it had
    const frames = [
      ...framesFor([chain[0]!, chain[2]!], { block: B - 1, logIndex: 0 }),
      emptyFrame({ block: B + 1, logIndex: 0 }, { block: B, logIndex: 2 }),
    ];
    const h = harness(chain, frames, B + 5);
    h.apply(markerEvent({ anchor: null, through: B - 1 }));
    await until(() => h.empties() > 0); // the stream's cursor is B + 1
    expect(h.value(E1)).toEqual([1]);
    h.reconcileFrom$.next({ baseline: B - 1, frontier: B - 1 });
    await until(() => (syncHealth.reconciledThrough ?? 0) >= B + 1);
    h.stop();
    expect(h.value(E1)).toEqual([2]);
    expect(syncHealth.reconcileRepairs).toBe(1); // E2 was rewritten with its own value
    expect(syncHealth.lastRepair).toMatchObject({
      block: B,
      component: 'Value',
      entity: formatEntityID(`0x${E1.toString(16)}`),
    });
    expect(Date.parse(syncHealth.lastRepair!.at)).not.toBeNaN();
    expect(repairLines()).toBe(1);
  });

  it('counts none at the cursor s own block: the pass proves C while the stream is mid-C (and the late frames of C change nothing)', async () => {
    const C = 600;
    const chain: ChainLog[] = [
      { block: C, tx: 1, logIndex: 3, entity: E1, value: [31] },
      { block: C, tx: 1, logIndex: 4, entity: E2, value: [9] },
      { block: C, tx: 3, logIndex: 3, entity: E1, value: [32] },
      { block: C, tx: 5, logIndex: 3, entity: E1, value: [33] },
    ];
    const gate = deferred();
    const all = framesFor(chain, { block: C - 1, logIndex: 0 });
    // the server sends tx 1's two logs, then holds the rest of C back
    const h = harness(chain, [all[0]!, all[1]!, gate.p, all[2]!, all[3]!], C + 10);
    h.apply(markerEvent({ anchor: null, through: C - 1 }));
    await until(() => h.value(E2) !== undefined); // the stream is in C
    expect(h.value(E1)).toEqual([31]);
    h.reconcileFrom$.next({ baseline: C - 1, frontier: C - 1 });
    await until(() => syncHealth.reconciledThrough === C); // the pass [C, C], applied and pruned
    // the reconcile CHANGED E1 (31 -> 33), but C is the cursor's own block
    expect(h.value(E1)).toEqual([33]);
    expect(syncHealth.reconcileRepairs).toBe(0);
    expect(syncHealth.lastRepair).toBeUndefined();
    // the rest of C arrives: tx 3 then tx 5 — neither is newer than C s final write
    const skipped = syncHealth.olderWritesSkipped;
    gate.release();
    await until(() => syncHealth.olderWritesSkipped >= skipped + 2);
    h.stop();
    expect(h.value(E1)).toEqual([33]);
    expect(repairLines()).toBe(0);
  });

  it('counts none for a GAP heal, however much it changes', async () => {
    const chain: ChainLog[] = [
      { block: 700, tx: 1, logIndex: 1, entity: E1, value: [1] },
      { block: 703, tx: 1, logIndex: 1, entity: E1, value: [3] },
      { block: 703, tx: 2, logIndex: 1, entity: E2, value: [4] },
    ];
    // frame 2 points at a log the client never saw: heal [700, 705]
    const frames = [
      ...framesFor([chain[0]!], { block: 699, logIndex: 0 }),
      emptyFrame({ block: 705, logIndex: 1 }, { block: 703, logIndex: 1 }),
    ];
    const h = harness(chain, frames, 720);
    await until(() => syncHealth.gapsHealed === 1);
    await until(() => h.value(E2) !== undefined);
    h.stop();
    expect([h.value(E1), h.value(E2)]).toEqual([[3], [4]]);
    expect(syncHealth.reconcileRepairs).toBe(0);
    expect(repairLines()).toBe(0);
  });

  it('counts none for a CATCH-UP read ahead of the stream', async () => {
    const chain: ChainLog[] = [
      { block: 800, tx: 1, logIndex: 1, entity: E1, value: [1] },
      { block: 802, tx: 3, logIndex: 1, entity: E1, value: [2] },
      { block: 803, tx: 1, logIndex: 7, entity: E2, value: [6] },
    ];
    const h = harness(chain, framesFor([chain[0]!], { block: 799, logIndex: 0 }), 820);
    h.apply(markerEvent({ anchor: null, through: 800 }));
    await until(() => h.value(E1) !== undefined);
    syncHooks.requestCatchUp!(803);
    await until(() => h.value(E2) !== undefined);
    h.stop();
    expect([h.value(E1), h.value(E2)]).toEqual([[2], [6]]);
    expect(syncHealth.appliedThrough).toBe(803);
    expect(syncHealth.reconcileRepairs).toBe(0);
    expect(repairLines()).toBe(0);
  });
});

describe('sameComponentValue: exact, for every value shape the decoder produces', () => {
  it.each([
    ['equal numbers', { value: 7 }, { value: 7 }, true],
    ['different numbers', { value: 7 }, { value: 8 }, false],
    ['a number is not its string', { value: 1 }, { value: '1' }, false],
    ['equal hex strings', { value: '0x1dfd' }, { value: '0x1dfd' }, true],
    ['different hex strings', { value: '0x1dfd' }, { value: '0x1dfe' }, false],
    ['equal bigints', { value: 2n ** 200n }, { value: 2n ** 200n }, true],
    ['different bigints', { value: 2n ** 200n }, { value: 2n ** 200n + 1n }, false],
    ['a bigint is not its number', { value: 5n }, { value: 5 }, false],
    ['booleans', { value: true }, { value: false }, false],
    ['equal arrays', { value: [1, 2, 3] }, { value: [1, 2, 3] }, true],
    ['arrays differing in one element', { value: [1, 2, 3] }, { value: [1, 2, 4] }, false],
    ['arrays differing in length', { value: [1, 2] }, { value: [1, 2, 0] }, false],
    ['string arrays', { value: ['0xa', '0xb'] }, { value: ['0xa', '0xb'] }, true],
    ['an empty array is not absent', { value: [] }, undefined, false],
    ['absent vs removed', undefined, undefined, true],
    ['absent vs a value', undefined, { value: 0 }, false],
    ['a value vs removed', { value: '0x0' }, undefined, false],
    ['multi-key, equal', { a: 1, b: '0x2' }, { b: '0x2', a: 1 }, true],
    ['multi-key, one differs', { a: 1, b: '0x2' }, { a: 1, b: '0x3' }, false],
    ['a key only on one side', { a: 1 }, { a: 1, b: undefined }, true],
    ['a key only on one side, with a value', { a: 1 }, { a: 1, b: 0 }, false],
  ])('%s', (_name, a, b, same) => {
    expect(sameComponentValue(a as never, b as never)).toBe(same);
    expect(sameComponentValue(b as never, a as never)).toBe(same);
  });
});

describe('a repair is a block-FINAL write', () => {
  it('a stamped write that is NOT block-final is applied by the guard but never counted; the same write marked final is', () => {
    // No live source stamps a non-final write: stream.ts stamps only the
    // periodic reconcile's healRange output, which is always final. This pins
    // the clause that says so — a repair is a proven block-final write, never
    // a write that a later one of the same block may still supersede.
    const world = createWorld();
    const components = createComponents(world);
    const ecsEvents$ = new Subject<NetworkEvent[]>();
    applyNetworkUpdates(
      world,
      components,
      ecsEvents$ as never,
      { [COMPONENT]: 'Value' } as Record<string, keyof Components> as never,
      new Subject<Ack>()
    );
    const entity = formatEntityID(`0x${E1.toString(16)}`);
    const write = (value: number[], extra: Record<string, unknown> = {}) =>
      ({
        type: 'NetworkComponentUpdate',
        component: COMPONENT,
        entity,
        value: { value },
        blockNumber: 900,
        logIndex: 1,
        lastEventInTx: true,
        txHash: '0x1',
        ...extra,
      }) as unknown as NetworkEvent;
    const value = () => getComponentValue(components.Value, world.entityToIndex.get(entity)!)?.value;

    ecsEvents$.next([write([1])]); // a stream write: (900, not final)
    ecsEvents$.next([write([2], { reconcileCursor: 950 })]); // stamped, below the cursor, NOT final
    expect(value()).toEqual([2]); // the guard applied it (same block, nothing final there)
    expect(syncHealth.reconcileRepairs).toBe(0);
    expect(repairLines()).toBe(0);

    ecsEvents$.next([write([3], { reconcileCursor: 950, final: true })]);
    expect(value()).toEqual([3]);
    expect(syncHealth.reconcileRepairs).toBe(1);
    expect(repairLines()).toBe(1);
    world.dispose();
  });
});
