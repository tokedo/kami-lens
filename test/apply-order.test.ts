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
import { Subject } from 'rxjs';
import { describe, expect, it } from 'vitest';

import type { StreamResponse } from 'clients/kamigaze';
import { createDecode } from 'engine/encoders';
import { Components, createWorld, getComponentValue } from 'engine/recs';
import { formatComponentID, formatEntityID } from 'engine/utils';
import { createComponents } from 'network/components';
import { applyNetworkUpdates } from 'network/setup';
import { resetSyncHealth, syncHealth } from '../src/sync-health';
import { Ack } from 'workers/sync';
import { createStream, type StreamClient } from 'workers/sync/stream';
import { createFetchWorldEventsInBlockRange } from 'workers/sync/utils';
import { NetworkComponentUpdate, NetworkEvent, NetworkEvents } from 'workers/types';

const WORLD = '0x2729174c265dbBd8416C6449E0E813E88f43D0E7';
const abi = JSON.parse(
  readFileSync(path.resolve(__dirname, '../src/abi/World.json'), 'utf8')
).abi as unknown[];
const iface = new Interface(abi as never);

/** A component whose schema the decoder knows (uint32[]), so a
 * ComponentValueSet log round-trips through the real decode. */
const COMPONENT_ID = '0xb3f96e7944f99619a1086b9a1272bbdff635f1cac9c8bf7ba6ce1a9aa202f19c';
const ENTITY = 0xfeedn;

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
      transactionIndex: 0,
      index: l.logIndex,
      transactionHash,
    },
    wire: {
      address: WORLD.toLowerCase(),
      topics,
      data,
      blockNumber: `0x${l.block.toString(16)}`,
      transactionIndex: '0x0',
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
