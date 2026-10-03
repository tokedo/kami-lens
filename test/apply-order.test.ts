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

import { Interface } from 'ethers';
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

// ------------------------------------------- 1. heal events keep their place

describe('A2(c): a range read keeps each log s real block and index', () => {
  /** One ComponentValueRemoved log as the node returns it (no value decode
   * needed, which keeps the fake honest about everything else). */
  const removedLog = (block: number, logIndex: number, entity: bigint) => {
    const { topics, data } = iface.encodeEventLog('ComponentValueRemoved', [
      7n,
      '0x000000000000000000000000000000000000c0de',
      entity,
    ]);
    return {
      address: WORLD,
      topics,
      data,
      blockNumber: block,
      transactionIndex: 0,
      index: logIndex,
      transactionHash: `0x${block.toString(16).padStart(64, '0')}`,
    };
  };

  it('events from [100, 110] are stamped with THEIR block, and carry a log index', async () => {
    const logs = [removedLog(100, 4, 0xaaan), removedLog(105, 1, 0xbbbn)];
    const provider = {
      _getFilter: (f: unknown) => f,
      getLogs: async () => logs,
    };
    const fetchWorldEvents = createFetchWorldEventsInBlockRange(
      provider as never,
      { address: WORLD, abi: iface } as never,
      false,
      createDecode()
    );
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
    const COMPONENT = formatComponentID('0x1234');
    const ENTITY = formatEntityID('0xfeed');
    const mappings = { [COMPONENT]: 'Value' } as Record<string, keyof Components>;
    const ecsEvents$ = new Subject<NetworkEvent[]>();
    applyNetworkUpdates(world, components, ecsEvents$ as never, mappings as never, new Subject<Ack>());

    const write = (value: number, blockNumber: number, logIndex: number) =>
      ({
        type: NetworkEvents.NetworkComponentUpdate,
        component: COMPONENT,
        entity: ENTITY,
        value: { value },
        blockNumber,
        logIndex,
        lastEventInTx: true,
        txHash: `0xtx${blockNumber}-${logIndex}`,
      }) as unknown as NetworkComponentUpdate;

    // the STREAM delivered both writes, in order: start at block 100, stop at 105
    ecsEvents$.next([write(1, 100, 3)]);
    ecsEvents$.next([write(2, 105, 0)]);
    const entity = world.entityToIndex.get(ENTITY)!;
    expect(getComponentValue(components.Value, entity)?.value).toBe(2);

    // the reconcile reads [100, 105]. The head it proved came from one
    // backend (>= 105); the logs came from another, whose head is 103 — it
    // clamps toBlock and answers the START only, with no error. The fake
    // reproduces createFetchWorldEventsInBlockRange's stamp: block = range end.
    const ranges: [number, number][] = [];
    const fetchWorldEvents = async (from: number, to: number) => {
      ranges.push([from, to]);
      const laggingHead = 103;
      const out: NetworkComponentUpdate<Components>[] = [];
      if (from <= 100 && 100 <= Math.min(to, laggingHead)) {
        out.push({ ...write(1, to, 3) } as never);
      }
      return out;
    };
    const reconcileFrom$ = new Subject<number>();
    const stream$ = createStream({
      url: 'http://fake',
      worldAddress: WORLD,
      decode: createDecode(),
      includeSystemCalls: false,
      fetchWorldEvents: fetchWorldEvents as never,
      rpcHead: { cached: () => 10_000, fetch: async () => 10_000 },
      createClient: () => scriptedClient([frame(100, 3, 99, 0), frame(105, 0, 100, 3)]),
      timeoutMs: 30_000,
      reconcileFrom$,
      reconcileIntervalMs: 40,
    });
    reconcileFrom$.next(99);
    const sub = stream$.subscribe((e) => ecsEvents$.next([e as NetworkEvent]));
    await new Promise((r) => setTimeout(r, 200));
    sub.unsubscribe();
    world.dispose();

    expect(ranges).toContainEqual([100, 105]); // the reconcile really ran
    // (c) the newest write for the key is still the one served
    expect.soft(getComponentValue(components.Value, entity)?.value).toBe(2);
    // (b) and the verified bound does not claim blocks the answer never covered
    expect.soft(syncHealth.reconciledThrough).toBeLessThanOrEqual(103);
  });
});
