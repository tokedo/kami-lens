// A3 + A2(c) — the boot window converges to chain truth, and a short proof
// inside it never regresses a value.
//
// TWO BOOT NUMBERS, and they point in opposite directions:
//
//   - the STAMP (the reconcile baseline's partner) is the LOWEST block any
//     stream of the snapshot delta was served at — what the loaded cache may
//     claim to hold;
//   - the FRONTIER is the HIGHEST block any position-less data loaded at boot
//     could reflect.
//
// The boot-window replay re-reads (baseline, cursor] from the chain. Because
// the loaded values carry no position, an in-order replay that stopped short
// of the frontier could land an OLDER chain write on a value the delta had
// already brought forward. So a chain range over the boot window is applied
// only once it is proven through at least the frontier.
//
// The whole path is real: the snapshot delta (fetchSnapshot) over a scripted
// snapshot service whose GetState streams are served by replicas at different
// blocks, the cache applied to a mirror through applyNetworkUpdates, the
// stream's reconcile reading a model chain through the real range reader and
// its batch proof, and the apply path's ordering guard.

import { packTuple } from '@mud-classic/utils';
import { Subject } from 'rxjs';
import { describe, expect, it } from 'vitest';

import type { KamigazeServiceClient, StreamResponse } from 'clients/kamigaze';
import { createDecode } from 'engine/encoders';
import { Components, createWorld, getComponentValue } from 'engine/recs';
import { formatComponentID, formatEntityID } from 'engine/utils';
import { createComponents } from 'network/components';
import { applyNetworkUpdates } from 'network/setup';
import { resetSyncHealth, syncHealth } from '../src/sync-health';
import { Ack } from 'workers/sync';
import { fetchSnapshot } from 'workers/sync/snapshot';
import {
  createStateCache,
  getStateCacheEntries,
  storeStateEvent,
  type StateCache,
} from 'workers/sync/state';
import { createStream, type StreamClient } from 'workers/sync/stream';
import { NetworkEvent, NetworkEvents } from 'workers/types';
import {
  COMPONENT_ID,
  type ChainLog,
  WORLD,
  encodeValue,
  poolProvider,
  reader,
  truthAt,
} from './support/chain';

const COMPONENT = formatComponentID(COMPONENT_ID);
const E1 = 0xe1n;
const E2 = 0xe2n;
const E3 = 0xe3n;
const id = (e: bigint) => formatEntityID(`0x${e.toString(16)}`);

/** The cache a previous run left at block 900. */
const AT_900 = new Map<bigint, number[] | undefined>([
  [E1, [0]],
  [E2, [5]],
  [E3, [6]],
]);

/** The chain above it. E1 moves three times (one of them above the state
 * block), E2 is removed early, E3 is set and then removed late. */
const CHAIN: ChainLog[] = [
  { block: 901, logIndex: 2, tx: 1, entity: E1, value: [1] },
  { block: 905, logIndex: 0, tx: 2, entity: E2 },
  { block: 950, logIndex: 4, tx: 3, entity: E1, value: [2] },
  { block: 990, logIndex: 1, tx: 4, entity: E3, value: [7] },
  { block: 1002, logIndex: 0, tx: 5, entity: E1, value: [3] },
  { block: 1004, logIndex: 3, tx: 6, entity: E3 },
];

function cacheAt900(): StateCache {
  const cache = createStateCache();
  for (const [e, v] of AT_900) {
    storeStateEvent(cache, {
      type: NetworkEvents.NetworkComponentUpdate,
      component: COMPONENT,
      entity: id(e) as never,
      value: { value: v },
      blockNumber: 900,
    });
  }
  cache.blockNumber = 900;
  cache.lastKamigazeBlock = 900;
  cache.lastKamigazeComponent = cache.components.length - 1;
  cache.lastKamigazeEntity = cache.entities.length - 1;
  cache.kamigazeNonce = 5;
  return cache;
}

/** The snapshot service: GetStateBlock answers 1000; the values stream is
 * served by a replica at `valuesAt`, the removals stream by one at
 * `removalsAt`. Each serves the latest event per key in (fromBlock, head]. */
function deltaService(cache: StateCache, valuesAt: number, removalsAt: number): KamigazeServiceClient {
  const packed = (e: bigint) =>
    packTuple([cache.componentToIndex.get(COMPONENT)!, cache.entityToIndex.get(id(e))!]);
  const latest = (fromBlock: number, head: number) => {
    const out = new Map<bigint, ChainLog>();
    for (const l of [...CHAIN].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)) {
      if (l.block > fromBlock && l.block <= head) out.set(l.entity, l);
    }
    return [...out.values()];
  };
  return {
    getStateBlock: async () => ({ blockNumber: 1000, nonce: 5 }),
    getComponents: async () => ({ components: [] }),
    getEntities: async function* () {
      yield { entities: [], pending: 0 };
    },
    getState: async function* ({ fromBlock, removals }: { fromBlock: number; removals?: boolean }) {
      const head = removals ? removalsAt : valuesAt;
      const rows = latest(fromBlock, head).filter((l) => (removals ? l.value === undefined : l.value !== undefined));
      yield {
        state: rows.map((l) => ({
          packedIdx: packed(l.entity),
          data: removals ? new Uint8Array() : Buffer.from(encodeValue(l.value!).slice(2), 'hex'),
        })),
        pending: 0,
        lastBlockNumber: rows.length ? Math.max(...rows.map((l) => l.block)) : 0,
      };
    },
  } as unknown as KamigazeServiceClient;
}

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

function streamClient(frames: StreamResponse[]): StreamClient {
  return {
    subscribeToStream: (() =>
      (async function* () {
        for (const f of frames) {
          await new Promise((r) => setTimeout(r, 2));
          yield f;
        }
        await new Promise(() => {});
      })()) as StreamClient['subscribeToStream'],
    getEventsSince: (async () => ({ events: [], latestBlock: 0 })) as never,
  };
}

/** Boot: delta the 900 cache, build a mirror from it, start the stream with
 * its boot-window reconcile over a backend whose head `head()` decides. */
async function boot(valuesAt: number, removalsAt: number, head: () => number, passMax?: number) {
  resetSyncHealth();
  const loaded = await fetchSnapshot(
    cacheAt900(),
    deltaService(cacheAt900(), valuesAt, removalsAt),
    createDecode(),
    10,
    () => {},
    () => {}
  );
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
  ecsEvents$.next([...getStateCacheEntries(loaded)] as NetworkEvent[]);
  const read = () =>
    new Map(
      [E1, E2, E3].map((e) => {
        const ent = world.entityToIndex.get(id(e));
        const v = ent === undefined ? undefined : getComponentValue(components.Value, ent)?.value;
        return [e, v as number[] | undefined];
      })
    );

  const reconcileFrom$ = new Subject<{ baseline: number; frontier: number }>();
  const provider = poolProvider(CHAIN, { single: head, batch: head });
  const stream$ = createStream({
    url: 'http://fake',
    worldAddress: WORLD,
    decode: createDecode(),
    includeSystemCalls: false,
    fetchWorldEvents: reader(provider),
    rpcHead: { cached: head, fetch: async () => head() },
    createClient: () => streamClient([frame(1006, 0, 1005, 0), frame(1007, 1, 1006, 0)]),
    timeoutMs: 30_000,
    reconcileFrom$,
    reconcileIntervalMs: 30,
    reconcilePaceMs: 0,
    reconcileCatchUpGapMs: 5,
    ...(passMax ? { reconcilePassMaxBlocks: passMax } : {}),
  });
  const sub = stream$.subscribe((e) => ecsEvents$.next([e as NetworkEvent]));
  // the Worker's seed: baseline = the pre-delta block, frontier = the highest
  // block any position-less boot data may reflect
  const frontier = Math.max(900, loaded.lastKamigazeBlock, loaded.servedHigh ?? 0, 1007);
  reconcileFrom$.next({ baseline: 900, frontier });
  const stop = () => {
    sub.unsubscribe();
    world.dispose();
  };
  return { loaded, read, stop, provider };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const truth = truthAt(CHAIN, 1007, AT_900);

describe('A3: the boot window converges to chain truth', () => {
  // what each GetState stream was SERVED at is the block of its newest row:
  // values-ahead serves E1@1002 and removals E2@905; removals-ahead serves
  // E1@950 and E2@905 + E3@1004
  it.each([
    ['values AHEAD of removals', 1004, 960, 905, 1002],
    ['removals AHEAD of values', 960, 1004, 950, 1004],
  ])('%s: stamp = the lowest served block, and the replay lands on chain truth', async (_c, valuesAt, removalsAt, stamp, high) => {
    const { loaded, read, stop } = await boot(valuesAt, removalsAt, () => 5_000);
    // the cache claims only what every stream of the delta was served at (the
    // state block said 1000), and remembers the highest block it reached
    expect(loaded.lastKamigazeBlock).toBe(stamp);
    expect(loaded.blockNumber).toBe(stamp);
    expect(loaded.servedHigh).toBe(high);
    // ...and what was loaded is NOT chain truth at either block
    expect(read()).not.toEqual(truth);

    await settle(250);
    stop();
    expect(read()).toEqual(truth);
    expect(syncHealth.reconciledThrough).toBeGreaterThanOrEqual(1004);
  });
});

describe('A2(c) + A3: a proof that stops inside the boot window regresses nothing', () => {
  it('a lagging backend proves (900, 979]: nothing is applied; once it catches up, the replay converges', async () => {
    let backendHead = 980; // proves through 979: below the frontier (1007)
    const { read, stop } = await boot(1004, 960, () => backendHead);
    const loadedView = read();
    // the loaded E1 is [3] (the values replica served 1002). An in-order
    // replay of (900, 979] would land E1 = [2] (block 950) on it.
    expect(loadedView.get(E1)).toEqual([3]);

    await settle(200);
    expect(read()).toEqual(loadedView); // not one value moved
    expect(syncHealth.reconciledThrough).toBe(900); // and nothing was claimed

    backendHead = 5_000; // the backend catches up
    await settle(250);
    stop();
    expect(read()).toEqual(truth);
    expect(syncHealth.reconciledThrough).toBeGreaterThanOrEqual(1004);
  });
});

describe('A3: a boot window longer than one reconcile pass', () => {
  it('is read in passes and HELD until proven through the frontier, then applied once', async () => {
    // 20-block passes over a 107-block window: six passes, every one but the
    // last proven below the frontier. Applying each as it came would replay
    // (900, 920] over the delta's newer values; dropping each would re-read
    // the first 20 blocks forever (both were live failure modes).
    const { read, stop, provider } = await boot(1004, 960, () => 5_000, 20);
    await settle(400);
    stop();
    expect(read()).toEqual(truth);
    expect(syncHealth.reconciledThrough).toBeGreaterThanOrEqual(1004);
    // ~6 chunk reads, not a loop re-reading the same 20 blocks
    expect(provider.served.batches).toBeLessThan(12);
  });
});
