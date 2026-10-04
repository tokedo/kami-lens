// A2 — a chain re-read can never regress state.
//
// The mirror is "latest write per key across everything applied". The
// periodic reconcile and the gap heal re-read a block range from the chain
// and the apply path (network/setup/utils.ts applyNetworkUpdates) writes
// every event it is handed, unconditionally, in arrival order. That is safe
// only if the re-read is COMPLETE up to the cursor: a re-read that stops
// short re-applies the range's OLDER writes and omits its newest ones.
//
// The node behind the public endpoint clamps `toBlock` to its own head and
// answers a short list with no error (measured: getLogs to head+100 returns
// the logs through head-1, HTTP 200, no error field), and the endpoint is a
// balanced pool, so a head proven on one request says nothing about the
// backend that serves the next. And the events a range read produces cannot
// be ordered against what is already applied: every one is stamped with the
// RANGE END as its block (workers/sync/utils.ts) and none carries its log
// index.
//
// Both tests drive the REAL range reader (createFetchWorldEventsInBlockRange)
// over a fake JSON-RPC provider that models the measured endpoint: a pool of
// backends, one fresh and one lagging; single requests may land on either; a
// JSON-RPC batch is ONE HTTP request and is served by ONE backend (measured,
// see the leg-A gate record). The provider answers both the ethers `getLogs`
// path and a raw batch `_send`, so the reader may use either.

import { AbiCoder, Interface } from 'ethers';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { firstValueFrom, of, Subject, toArray } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';

import type { StreamResponse } from 'clients/kamigaze';
import { createDecode } from 'engine/encoders';
import { Components, createWorld, getComponentValue } from 'engine/recs';
import { formatComponentID, formatEntityID } from 'engine/utils';
import { createComponents } from 'network/components';
import { applyNetworkUpdates } from 'network/setup';
import { resetSyncHealth, syncHealth } from '../src/sync-health';
import { Ack } from 'workers/sync';
import { createStateCache, getStateCacheEntries, storeStateEvents } from 'workers/sync/state';
import {
  createStream,
  createTransformWorldEvents,
  fillGap,
  markerEvent,
  type StreamClient,
} from 'workers/sync/stream';
import { collapseLatest, healRange, type HealReason } from 'workers/sync/stream/heal';
import {
  createFetchWorldEventsInBlockRange,
  createLatestEventStreamRPC,
  fetchEventsInBlockRangeChunked,
} from 'workers/sync/utils';
import { NetworkComponentUpdate, NetworkEvent, NetworkEvents } from 'workers/types';
import * as chain_ from './support/chain';

const WORLD = '0x2729174c265dbBd8416C6449E0E813E88f43D0E7';
const abi = JSON.parse(
  readFileSync(path.resolve(__dirname, '../src/abi/World.json'), 'utf8')
).abi as unknown[];
const iface = new Interface(abi as never);

/** A component whose schema the decoder knows (uint32[]), so a
 * ComponentValueSet log round-trips through the real decode. */
const COMPONENT_ID = '0xb3f96e7944f99619a1086b9a1272bbdff635f1cac9c8bf7ba6ce1a9aa202f19c';
const ENTITY = 0xfeedn;

/** `tx` is the log's transaction index within its block and `logIndex` its
 * index WITHIN THAT TRANSACTION, as the chain numbers them (1.0.1; see
 * test/support/chain.ts). Every fixture in this section has one log per
 * block, so the numbers below did not change when the encoder stopped putting
 * every log at transactionIndex 0. */
type ChainLog = { block: number; logIndex: number; tx: number; value?: number[] };

/** A log as ethers' getLogs returns it AND as the raw JSON-RPC wire carries it. */
function encode(l: ChainLog) {
  const { topics, data } =
    l.value === undefined
      ? iface.encodeEventLog('ComponentValueRemoved', [
          BigInt(COMPONENT_ID),
          '0x000000000000000000000000000000000000c0de',
          ENTITY,
        ])
      : iface.encodeEventLog('ComponentValueSet', [
          BigInt(COMPONENT_ID),
          '0x000000000000000000000000000000000000c0de',
          ENTITY,
          AbiCoder.defaultAbiCoder().encode(['uint32[]'], [l.value]),
        ]);
  const transactionHash = `0x${l.tx.toString(16).padStart(64, '0')}`;
  return {
    ethers: {
      address: WORLD,
      topics,
      data,
      blockNumber: l.block,
      transactionIndex: l.tx,
      index: l.logIndex,
      transactionHash,
    },
    wire: {
      address: WORLD.toLowerCase(),
      topics,
      data,
      blockNumber: `0x${l.block.toString(16)}`,
      transactionIndex: `0x${l.tx.toString(16)}`,
      logIndex: `0x${l.logIndex.toString(16)}`,
      transactionHash,
      blockHash: `0x${l.block.toString(16).padStart(64, '0')}`,
      removed: false,
    },
  };
}

/** The measured endpoint: `heads` are the backends' heads; a single request
 * picks `single()`'s backend, a batch is served whole by `batch()`'s. A
 * backend clamps toBlock to its head and answers short, with no error. */
function poolProvider(
  chain: ChainLog[],
  route: { single: () => number; batch: () => number }
) {
  const logsFor = (head: number, from: number, to: number) =>
    chain.filter((l) => l.block >= from && l.block <= Math.min(to, head)).map(encode);
  const n = (x: unknown) => (typeof x === 'string' ? parseInt(x, 16) : Number(x));
  return {
    _getFilter: (f: unknown) => f,
    getLogs: async (f: { fromBlock: unknown; toBlock: unknown }) =>
      logsFor(route.single(), n(f.fromBlock), n(f.toBlock)).map((l) => l.ethers),
    getBlockNumber: async () => route.single(),
    _send: async (payload: unknown) => {
      const calls = (Array.isArray(payload) ? payload : [payload]) as {
        id: number;
        method: string;
        params: { fromBlock: string; toBlock: string }[];
      }[];
      const head = route.batch(); // one HTTP request, one backend
      return calls.map((c) =>
        c.method === 'eth_blockNumber'
          ? { jsonrpc: '2.0', id: c.id, result: `0x${head.toString(16)}` }
          : c.method === 'eth_getLogs'
            ? {
                jsonrpc: '2.0',
                id: c.id,
                result: logsFor(head, n(c.params[0]!.fromBlock), n(c.params[0]!.toBlock)).map(
                  (l) => l.wire
                ),
              }
            : { jsonrpc: '2.0', id: c.id, error: { code: -32601, message: 'unsupported' } }
      );
    },
  };
}

const reader = (provider: unknown) =>
  createFetchWorldEventsInBlockRange(
    provider as never,
    { address: WORLD, abi: iface } as never,
    false,
    createDecode()
  );

// ------------------------------------------- 1. heal events keep their place

describe('A2(c): a range read keeps each log s real block and index', () => {
  it('events from [100, 110] are stamped with THEIR block, and carry a log index', async () => {
    const chain: ChainLog[] = [
      { block: 100, logIndex: 4, tx: 1 },
      { block: 105, logIndex: 1, tx: 2 },
    ];
    // every backend fresh: this test is about the stamp, not the proof
    const fetchWorldEvents = reader(poolProvider(chain, { single: () => 1_000, batch: () => 1_000 }));
    const events = (await fetchWorldEvents(100, 110)) as (NetworkComponentUpdate & {
      logIndex?: number;
    })[];
    expect(events).toHaveLength(2);
    expect.soft(events.map((e) => e.blockNumber)).toEqual([100, 105]);
    expect.soft(events.map((e) => e.logIndex)).toEqual([4, 1]);
  });
});

// ------------------------------- 2. a short re-read never regresses a key

/** A stream frame with no events of its own: the cursor moves, nothing is
 * applied by the frame itself. */
const frame = (b: number, li: number, pb: number, pli: number): StreamResponse =>
  ({
    blockNumber: b,
    logIndex: li,
    prevBlockNumber: pb,
    prevLogBlockNumber: pb,
    prevLogIndex: pli,
    blockTimestamp: 0,
    ecsEvents: [],
    transactionsConfirmed: [],
  }) as unknown as StreamResponse;

function scriptedClient(frames: StreamResponse[]): StreamClient {
  return {
    subscribeToStream: (() =>
      (async function* () {
        for (const f of frames) {
          await new Promise((r) => setTimeout(r, 5));
          yield f;
        }
        await new Promise(() => {});
      })()) as StreamClient['subscribeToStream'],
    getEventsSince: (async () => ({ events: [], latestBlock: 0 })) as never,
  };
}

describe('A2(c): a reconcile over a short chain answer never regresses a key', () => {
  it('a harvest STOP applied by the stream survives a re-read that only reaches its START', async () => {
    resetSyncHealth();
    const world = createWorld();
    const components = createComponents(world);
    const COMPONENT = formatComponentID(COMPONENT_ID);
    const ENTITY_ID = formatEntityID(`0x${ENTITY.toString(16)}`);
    const mappings = { [COMPONENT]: 'Value' } as Record<string, keyof Components>;
    const ecsEvents$ = new Subject<NetworkEvent[]>();
    applyNetworkUpdates(world, components, ecsEvents$ as never, mappings as never, new Subject<Ack>());

    // the chain: harvest START at (100, 3), STOP at (105, 0)
    const chain: ChainLog[] = [
      { block: 100, logIndex: 3, tx: 1, value: [1] },
      { block: 105, logIndex: 0, tx: 2, value: [2] },
    ];
    // what the STREAM delivered for those two logs, in order — the events a
    // stream frame produces, with the frame's own (block, logIndex)
    const streamed = (l: ChainLog) =>
      ({
        type: NetworkEvents.NetworkComponentUpdate,
        component: COMPONENT,
        entity: ENTITY_ID,
        value: { value: l.value },
        blockNumber: l.block,
        logIndex: l.logIndex,
        lastEventInTx: true,
        txHash: `0x${l.tx.toString(16).padStart(64, '0')}`,
      }) as unknown as NetworkComponentUpdate;
    ecsEvents$.next([streamed(chain[0]!)]);
    ecsEvents$.next([streamed(chain[1]!)]);
    const entity = world.entityToIndex.get(ENTITY_ID)!;
    expect(getComponentValue(components.Value, entity)?.value).toEqual([2]);

    // the reconcile reads [100, 105]. Its head proof comes from a FRESH
    // backend (10,000); the logs come from a LAGGING one at 103, which clamps
    // and answers the START only, with no error. A batch lands on the lagging
    // one too — it is the backend that served the logs.
    const fetchWorldEvents = reader(
      poolProvider(chain, { single: () => 103, batch: () => 103 })
    );
    const reconcileFrom$ = new Subject<number>();
    const stream$ = createStream({
      url: 'http://fake',
      worldAddress: WORLD,
      decode: createDecode(),
      includeSystemCalls: false,
      fetchWorldEvents,
      rpcHead: { cached: () => 10_000, fetch: async () => 10_000 },
      createClient: () => scriptedClient([frame(100, 3, 99, 0), frame(105, 0, 100, 3)]),
      timeoutMs: 30_000,
      reconcileFrom$,
      reconcileIntervalMs: 40,
    });
    reconcileFrom$.next(99);
    const sub = stream$.subscribe((e) => ecsEvents$.next([e as NetworkEvent]));
    await new Promise((r) => setTimeout(r, 300));
    sub.unsubscribe();
    world.dispose();

    expect(syncHealth.reconcilePasses).toBeGreaterThan(0); // the reconcile really ran
    // (c) the newest write for the key is still the one served
    expect.soft(getComponentValue(components.Value, entity)?.value).toEqual([2]);
    // (b) and the verified bound does not claim blocks the answer never covered
    expect.soft(syncHealth.reconciledThrough).toBeLessThanOrEqual(103);
  });
});


// ---------------- 3. 1.0.1 (field report 2026-10-04): one block, several transactions
//
// On Yominet a log's index restarts in every transaction (a real
// five-transaction block: 44 World logs indexed 1..16, then 1..7 four times),
// and a stream frame carries no transaction index. 1.0.0's guard packed
// `block * 2^20 + logIndex` and skipped an update whose position was not
// greater than the last one applied for its key — so a LATER transaction's
// write with an equal or lower index was dropped as "older", on the stream
// and again on every re-read of the block. The rule now: per key, the block
// of the last write applied and whether it was that block's FINAL write (as a
// proven, collapsed chain read says). An update of block B is skipped iff the
// key already holds a write of a later block, or B's final write. Every case
// below goes through the real applyNetworkUpdates; the stream's writes are
// the real transform of a frame, the chain's are the real range reader under
// the real healRange.

const L16_COMPONENT = formatComponentID(chain_.COMPONENT_ID);
const E1 = 0xe1n;
const E2 = 0xe2n;
const E3 = 0xe3n;

function caseMirror() {
  const world = createWorld();
  const components = createComponents(world);
  const ecsEvents$ = new Subject<NetworkEvent[]>();
  applyNetworkUpdates(
    world,
    components,
    ecsEvents$ as never,
    { [L16_COMPONENT]: 'Value' } as Record<string, keyof Components> as never,
    new Subject<Ack>()
  );
  const apply = (events: unknown[]) => ecsEvents$.next(events as NetworkEvent[]);
  const value = (e: bigint) => {
    const idx = world.entityToIndex.get(formatEntityID(`0x${e.toString(16)}`));
    return idx === undefined ? undefined : getComponentValue(components.Value, idx)?.value;
  };
  return { world, apply, value };
}

const transformFrame = createTransformWorldEvents(createDecode());
/** What the stream delivers for one log: the real transform of its frame. */
const streamed = (l: chain_.ChainLog) => transformFrame(chain_.frameFor(l, { block: 0, logIndex: 0 }));

/** A proven chain read of [from, to] — the real reader, the real healRange —
 * as the reconcile / catch-up (partial) or a gap heal (whole) makes it. */
async function chainRead(
  chain: chain_.ChainLog[],
  from: number,
  to: number,
  reason: HealReason,
  head = to + 10
) {
  const fetchWorldEvents = chain_.reader(
    chain_.poolProvider(chain, { single: () => head, batch: () => head })
  );
  const r = await healRange({
    from,
    to,
    reason,
    fetchWorldEvents,
    rpcHead: { cached: () => head, fetch: async () => head },
    partial: reason !== 'gap',
    headWaitMs: 50,
    headPollMs: 5,
  });
  if (!r.ok) throw new Error(`chain read ${from}..${to} deferred (${r.deferred})`);
  return r.events;
}

describe('1.0.1: two transactions write one key in one block', () => {
  beforeEach(() => resetSyncHealth());

  // one key, written by transaction 2 and then by transaction 4 of block B
  const B = 400;
  const tx2 = { block: B, tx: 2, logIndex: 5, entity: E1, value: [10] };
  const tx4same = { block: B, tx: 4, logIndex: 5, entity: E1, value: [20] };
  const tx4lower = { block: B, tx: 4, logIndex: 2, entity: E1, value: [20] };

  it('(a) stream: tx 2 then tx 4 at the SAME log index — both apply, in arrival order', () => {
    const m = caseMirror();
    m.apply(streamed(tx2));
    m.apply(streamed(tx4same));
    expect(m.value(E1)).toEqual([20]);
    m.world.dispose();
  });

  it('(b) stream: tx 4 s index is LOWER than tx 2 s — still both apply, tx 4 last', () => {
    const m = caseMirror();
    m.apply(streamed(tx2));
    m.apply(streamed(tx4lower));
    expect(m.value(E1)).toEqual([20]);
    m.world.dispose();
  });

  it('(c) the reconcile of that block, after (a), ends on the chain s final write', async () => {
    const m = caseMirror();
    m.apply(streamed(tx2));
    m.apply(streamed(tx4same));
    m.apply(await chainRead([tx2, tx4same], B, B, 'reconcile'));
    expect(m.value(E1)).toEqual([20]);
    m.world.dispose();
  });

  it('(d) the stream LOST tx 4 s frame: the reconcile repairs the key', async () => {
    const m = caseMirror();
    m.apply(streamed(tx2));
    expect(m.value(E1)).toEqual([10]);
    m.apply(await chainRead([tx2, tx4lower], B, B, 'reconcile'));
    expect(m.value(E1)).toEqual([20]);
    m.world.dispose();
  });

  it('(e) a gap heal of [a..B], then the stream s late frames of B: the heal s final write stands', async () => {
    const chain = [
      { block: 500, tx: 2, logIndex: 1, entity: E1, value: [1] },
      { block: 500, tx: 5, logIndex: 9, entity: E1, value: [5] },
      { block: 500, tx: 7, logIndex: 2, entity: E1, value: [7] },
    ];
    const m = caseMirror();
    m.apply(await chainRead(chain, 495, 500, 'gap'));
    expect(m.value(E1)).toEqual([7]);
    // the stream catches up with block 500 after the heal (its triggering
    // frame, or the frames behind it): none of it is newer than the heal
    m.apply(streamed(chain[1]!)); // tx 5, index 9 — HIGHER than the final write's 2
    expect(m.value(E1)).toEqual([7]);
    m.apply(streamed(chain[2]!));
    expect(m.value(E1)).toEqual([7]);
    // ...and a write of a later block is newer
    m.apply(streamed({ block: 501, tx: 1, logIndex: 1, entity: E1, value: [8] }));
    expect(m.value(E1)).toEqual([8]);
    m.world.dispose();
  });

  it('(f) a catch-up read AHEAD of the stream, then the stream s frames for those blocks', async () => {
    const chain = [
      { block: 500, tx: 1, logIndex: 1, entity: E1, value: [1] },
      { block: 501, tx: 1, logIndex: 8, entity: E1, value: [11] },
      { block: 501, tx: 3, logIndex: 2, entity: E1, value: [13] },
      { block: 502, tx: 1, logIndex: 1, entity: E2, value: [20] },
      { block: 503, tx: 2, logIndex: 1, entity: E1, value: [14] },
    ];
    const m = caseMirror();
    // the catch-up proves [500, 502] (the backend s head is 503)
    m.apply(await chainRead(chain, 500, 502, 'catch-up', 503));
    expect([m.value(E1), m.value(E2)]).toEqual([[13], [20]]);
    // the stream now delivers those blocks, in chain order
    for (const l of chain.slice(0, 4)) {
      m.apply(streamed(l));
      expect([m.value(E1), m.value(E2)]).toEqual([[13], [20]]);
    }
    m.apply(streamed(chain[4]!)); // block 503: past the catch-up
    expect(m.value(E1)).toEqual([14]);
    m.world.dispose();
  });

  it('(g) the reconcile proves block C while the stream is mid-C; the late frames of C change nothing — prune included', async () => {
    // one key written at the same index by three transactions of block C
    const C = 600;
    const chain = [
      { block: C, tx: 1, logIndex: 3, entity: E1, value: [31] },
      { block: C, tx: 1, logIndex: 4, entity: E2, value: [9] },
      { block: C, tx: 3, logIndex: 3, entity: E1, value: [32] },
      { block: C, tx: 5, logIndex: 3, entity: E1, value: [33] },
    ];
    const m = caseMirror();
    syncHealth.reconciledThrough = C - 2;
    m.apply(streamed(chain[0]!));
    m.apply(streamed(chain[1]!));
    // the pass reads [C-1, C] while the stream is in C, and ends in its
    // reconcile marker — which advances reconciledThrough to C and prunes
    m.apply(await chainRead(chain, C - 1, C, 'reconcile'));
    m.apply([markerEvent({ anchor: C - 2, through: C, reconciled: true })]);
    expect(syncHealth.reconciledThrough).toBe(C);
    expect(m.value(E1)).toEqual([33]);
    const skipped = syncHealth.olderWritesSkipped;
    // the rest of C arrives: no write of C is newer than C s final write
    m.apply(streamed(chain[2]!));
    expect(m.value(E1)).toEqual([33]);
    m.apply(streamed(chain[3]!));
    expect(m.value(E1)).toEqual([33]);
    expect(syncHealth.olderWritesSkipped).toBe(skipped + 2);
    m.world.dispose();
  });

  it('(h) a newer block s stream write, then a reconcile write of an older block: the newer one stands', async () => {
    const chain = [
      { block: 605, tx: 1, logIndex: 1, entity: E1, value: [5] },
      { block: 610, tx: 2, logIndex: 1, entity: E1, value: [6] },
    ];
    const m = caseMirror();
    m.apply(streamed(chain[1]!));
    // a lagging backend proves the pass only through 605
    const events = await chainRead(chain, 601, 610, 'reconcile', 606);
    expect(events.map((e) => e.blockNumber)).toEqual([605]);
    m.apply(events);
    expect(m.value(E1)).toEqual([6]);
    expect(syncHealth.olderWritesSkipped).toBe(1);
    m.world.dispose();
  });

  describe('(i) a raw range read over a multi-transaction block — ordered, never final', () => {
    // E1: three transactions, the same index; E2: removed then set by a later
    // transaction at the same index; E3: set, then removed by a later
    // transaction at a LOWER index
    const chain = [
      { block: 700, tx: 1, logIndex: 3, entity: E1, value: [31] },
      { block: 700, tx: 1, logIndex: 9, entity: E3, value: [5] },
      { block: 700, tx: 2, logIndex: 1, entity: E2 },
      { block: 700, tx: 3, logIndex: 1, entity: E2, value: [8] },
      { block: 700, tx: 3, logIndex: 3, entity: E1, value: [32] },
      { block: 700, tx: 4, logIndex: 2, entity: E3 },
      { block: 700, tx: 5, logIndex: 3, entity: E1, value: [33] },
    ];
    const truth = [[33], [8], undefined];
    const fetchWorldEvents = () =>
      chain_.reader(chain_.poolProvider(chain, { single: () => 710, batch: () => 710 }));
    const read = (m: ReturnType<typeof caseMirror>) => [m.value(E1), m.value(E2), m.value(E3)];

    it('the bootstrap fill (fillGap, RPC path) folded into the state cache', async () => {
      const events = await fillGap({
        kamigazeUrl: undefined,
        decode: createDecode(),
        fetchWorldEvents: fetchWorldEvents(),
        fromBlock: 690,
        toBlock: 700,
      });
      const cache = createStateCache();
      storeStateEvents(cache, events as never);
      const m = caseMirror();
      m.apply([...getStateCacheEntries(cache)]);
      expect(read(m)).toEqual(truth);
      m.world.dispose();
    });

    it('the same read applied as it comes (the chunked reader, and the no-stream RPC mode)', async () => {
      const chunked = await fetchEventsInBlockRangeChunked(fetchWorldEvents(), 690, 700);
      expect(chunked.some((e) => (e as { final?: boolean }).final)).toBe(false);
      const m1 = caseMirror();
      m1.apply(chunked);
      expect(read(m1)).toEqual(truth);
      m1.world.dispose();

      const live = await firstValueFrom(
        createLatestEventStreamRPC(of(700), fetchWorldEvents()).pipe(toArray())
      );
      const m2 = caseMirror();
      for (const e of live) m2.apply([e]);
      expect(read(m2)).toEqual(truth);
      m2.world.dispose();
    });
  });

  it('(j) a position-less diff value, then a proven chain range: the chain s final writes land, later frames of their block do not', async () => {
    const chain = [
      { block: 800, tx: 2, logIndex: 3, entity: E1, value: [5] },
      { block: 800, tx: 3, logIndex: 1, entity: E1, value: [6] },
    ];
    const m = caseMirror();
    m.apply(streamed({ block: 790, tx: 1, logIndex: 1, entity: E1, value: [1] }));
    // a Kamigaze diff event: no position, its block is the range START
    m.apply([
      {
        type: NetworkEvents.NetworkComponentUpdate,
        component: L16_COMPONENT,
        entity: formatEntityID(`0x${E1.toString(16)}`),
        value: { value: [4] },
        blockNumber: 780,
        lastEventInTx: true,
        txHash: '0xdiff',
      },
    ]);
    expect(m.value(E1)).toEqual([4]);
    // the frontier rule (stream.ts; test/boot-replay.test.ts) lets only a
    // range proven through the diff s frontier reach here
    m.apply(await chainRead(chain, 781, 800, 'reconcile'));
    expect(m.value(E1)).toEqual([6]);
    m.apply(streamed(chain[0]!));
    expect(m.value(E1)).toEqual([6]);
    m.world.dispose();
  });

  it('(j) a position-less value forgets the key s place: a re-read of the block its FINAL write came from lands again', async () => {
    // the wide-gap heal: a Kamigaze diff (no position) and then a chain
    // top-up of the diff s head, applied in that order (stream.ts healGap)
    const chain = [
      { block: 800, tx: 2, logIndex: 3, entity: E1, value: [5] },
      { block: 800, tx: 3, logIndex: 1, entity: E1, value: [6] },
    ];
    const m = caseMirror();
    m.apply(await chainRead(chain, 781, 800, 'reconcile'));
    expect(m.value(E1)).toEqual([6]); // E1 holds block 800's FINAL write
    m.apply([
      {
        type: NetworkEvents.NetworkComponentUpdate,
        component: L16_COMPONENT,
        entity: formatEntityID(`0x${E1.toString(16)}`),
        value: { value: [4] }, // a half-ingested diff: older than the chain
        blockNumber: 790,
        lastEventInTx: true,
        txHash: '0xdiff',
      },
    ]);
    expect(m.value(E1)).toEqual([4]);
    m.apply(await chainRead(chain, 798, 800, 'gap'));
    expect(m.value(E1)).toEqual([6]);
    m.world.dispose();
  });

  it('prune: reaching reconciledThrough R forgets the places of blocks below R, and keeps R s own', () => {
    // what forgetting MEANS, shown with writes no live source sends: below R
    // every block has been re-read complete, so nothing newer can arrive there
    // and the guard stops remembering; R itself may still be streaming
    const R = 650;
    const m = caseMirror();
    syncHealth.reconciledThrough = R - 10;
    const finalAt = (l: chain_.ChainLog) => streamed(l).map((e) => ({ ...e, final: true }));
    m.apply(finalAt({ block: R - 1, tx: 1, logIndex: 1, entity: E1, value: [1] }));
    m.apply(finalAt({ block: R, tx: 1, logIndex: 1, entity: E2, value: [2] }));
    m.apply([markerEvent({ anchor: R - 10, through: R, reconciled: true })]);
    expect(syncHealth.reconciledThrough).toBe(R);
    // E1 s place (R - 1) is forgotten: an older write is no longer refused
    m.apply(streamed({ block: R - 2, tx: 1, logIndex: 1, entity: E1, value: [10] }));
    expect(m.value(E1)).toEqual([10]);
    // E2 s place (R, final) is kept: a write of R is still refused
    m.apply(streamed({ block: R, tx: 2, logIndex: 1, entity: E2, value: [20] }));
    expect(m.value(E2)).toEqual([2]);
    m.world.dispose();
  });

  it('(k) a key pruned at reconciledThrough, then a gap heal that starts at that block', async () => {
    const R = 650;
    const chain = [
      { block: R, tx: 1, logIndex: 2, entity: E1, value: [1] },
      { block: R, tx: 1, logIndex: 5, entity: E3, value: [7] },
      { block: R, tx: 3, logIndex: 1, entity: E1, value: [2] },
      { block: R + 2, tx: 2, logIndex: 1, entity: E1, value: [3] },
      { block: R + 2, tx: 4, logIndex: 1, entity: E1, value: [4] },
    ];
    const m = caseMirror();
    syncHealth.reconciledThrough = R - 1;
    for (const l of chain.slice(0, 3)) m.apply(streamed(l));
    expect([m.value(E1), m.value(E3)]).toEqual([[2], [7]]);
    m.apply(await chainRead(chain, R, R, 'reconcile'));
    m.apply([markerEvent({ anchor: R - 1, through: R, reconciled: true })]);
    expect(syncHealth.reconciledThrough).toBe(R);
    // the gap heal re-reads from the reconciled block
    m.apply(await chainRead(chain, R, R + 2, 'gap'));
    expect([m.value(E1), m.value(E3)]).toEqual([[4], [7]]);
    // and the stream s frames of R + 2, arriving after it, are not newer
    m.apply(streamed(chain[3]!));
    expect([m.value(E1), m.value(E3)]).toEqual([[4], [7]]);
    m.world.dispose();
  });
});

describe('1.0.1: collapseLatest — chain position decides; arrival decides only what position cannot', () => {
  const ev = (value: number, place: { transactionIndex?: number; logIndex?: number; blockNumber?: number }) =>
    ({
      type: NetworkEvents.NetworkComponentUpdate,
      component: L16_COMPONENT,
      entity: formatEntityID(`0x${E1.toString(16)}`),
      value: { value: [value] },
      blockNumber: 900,
      lastEventInTx: true,
      txHash: '0xc0',
      ...place,
    }) as unknown as NetworkComponentUpdate;
  const values = (events: NetworkComponentUpdate[]) => events.map((e) => (e.value as { value: number[] }).value);

  it('one key, one block, no transaction index (the position cannot order them): the LATER arrival wins', () => {
    expect(values(collapseLatest([ev(1, { logIndex: 5 }), ev(2, { logIndex: 3 })]))).toEqual([[2]]);
  });

  it('one key, the SAME full position twice: the LATER arrival wins', () => {
    const at = { transactionIndex: 2, logIndex: 3 };
    expect(values(collapseLatest([ev(1, at), ev(2, at)]))).toEqual([[2]]);
  });

  it('one key, arriving out of chain order: the chain-later write wins whatever the arrival', () => {
    expect(
      values(collapseLatest([ev(5, { transactionIndex: 5, logIndex: 1 }), ev(3, { transactionIndex: 3, logIndex: 9 })]))
    ).toEqual([[5]]);
    expect(values(collapseLatest([ev(9, { blockNumber: 901, logIndex: 1 }), ev(8, { logIndex: 7 })]))).toEqual([
      [9],
    ]);
  });
});
