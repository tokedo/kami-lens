// A3 (the reconcile baseline) and A4 (one sync worker) — the bootstrap path of
// the REAL SyncWorker (workers/sync/Worker.ts), driven with its network edges
// replaced: the provider, the block-number stream, the snapshot service and
// the stream are scripted; the state store is the real file store on a
// temporary directory.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BehaviorSubject, NEVER, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    fetchSnapshot: null as null | ((cache: unknown) => Promise<unknown>),
    streams: [] as { reconcileFrom$?: { subscribe: (fn: (n: number) => void) => unknown } }[],
    seeds: [] as number[],
    fillGaps: [] as { fromBlock: number; toBlock: number }[],
  };
  return state;
});

vi.mock('engine/providers', () => ({
  createReconnectingProvider: async () => ({
    providers: { get: () => ({ json: { getBlockNumber: async () => 1010 } }) },
    dispose: () => {},
  }),
}));

vi.mock('engine/executors', () => ({
  createBlockNumberStream: () => ({ blockNumber$: new BehaviorSubject(1010), dispose: () => {} }),
}));

vi.mock('workers/sync/snapshot', () => ({
  createSnapshotClient: () => ({}),
  fetchSnapshot: (cache: unknown) => h.fetchSnapshot!(cache),
  fetchFromCdn: async () => {
    throw new Error('not used');
  },
  planCdnLoad: async () => undefined,
  isRateLimited: async () => false,
}));

vi.mock('workers/sync/stream', () => ({
  KEEPALIVE_INTERVAL_MS: 10_000,
  HEALTH_CHECK_BUFFER_MS: 2_000,
  createStream: (opts: (typeof h.streams)[number]) => {
    h.streams.push(opts);
    opts.reconcileFrom$?.subscribe((n) => h.seeds.push(n));
    return NEVER;
  },
  fillGap: async (opts: { fromBlock: number; toBlock: number }) => {
    h.fillGaps.push({ fromBlock: opts.fromBlock, toBlock: opts.toBlock });
    return [];
  },
}));

const { VERSION: CACHE_VERSION } = await import('cache/db');
const { createSyncWorker } = await import('workers/create');
const { InputType } = await import('workers/sync');
const state = await import('workers/sync/state');
const { NetworkEvents } = await import('workers/types');

const CHAIN = 1337;
const WORLD = '0x00000000000000000000000000000000000000ab';
const COMPONENT = '0x4350dba81aa91e31664a09d24a668f006169a11b3d962b7557aed362d3252aec';

let dataDir = '';
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kami-lens-worker-'));
  h.streams.length = 0;
  h.seeds.length = 0;
  h.fillGaps.length = 0;
  // a previous run left the cache at block 900, nonce 5
  const cache = state.createStateCache();
  state.storeStateEvent(cache, {
    type: NetworkEvents.NetworkComponentUpdate,
    component: COMPONENT,
    entity: '0x060d' as never,
    value: { value: '0xbeef' },
    blockNumber: 900,
  });
  cache.blockNumber = 900;
  cache.lastKamigazeBlock = 900;
  cache.kamigazeNonce = 5;
  await state.saveStateCacheToStore(
    await state.getStateStore(CHAIN, WORLD, CACHE_VERSION, dataDir),
    cache
  );
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

function start() {
  const worker = createSyncWorker(new Subject() as never);
  worker.input$.next({
    type: InputType.Config,
    data: {
      provider: { chainId: CHAIN, jsonRpcUrl: 'http://rpc.invalid', options: { batch: false } },
      worldContract: { address: WORLD, abi: {} as never },
      chainId: CHAIN,
      snapshotServiceUrl: 'https://kamigaze.invalid',
      streamServiceUrl: 'https://kamigaze.invalid',
      initialBlockNumber: 1,
      dataDir,
      fetchSystemCalls: false,
      reconcileIntervalMs: 120_000,
    } as never,
  });
  return worker;
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

describe('A3: the first reconcile covers the whole boot window', () => {
  it('the baseline is seeded at the PRE-DELTA cached block, not at the stream start', async () => {
    h.fetchSnapshot = async (cache) => {
      const c = cache as { lastKamigazeBlock: number; blockNumber: number };
      c.lastKamigazeBlock = 1000; // the delta's stamp
      c.blockNumber = 1000;
      return c;
    };
    const worker = start();
    await settle();
    worker.dispose();

    expect(h.fillGaps).toEqual([{ fromBlock: 1000, toBlock: 1010 }]); // the boot ran
    // the boot window is (900, 1010]: everything above the block this process
    // actually started from was supplied by the delta and the Kamigaze-first
    // gap fill, neither of which the chain has vouched for
    expect(h.seeds).toHaveLength(1);
    expect(h.seeds[0]).toBeLessThanOrEqual(900);
  });
});

describe('A4: a disposed sync worker stops', () => {
  it('a worker disposed mid-bootstrap never opens a stream or writes the store', async () => {
    let release!: () => void;
    let reached = false;
    h.fetchSnapshot = async (cache) => {
      reached = true;
      await new Promise<void>((r) => (release = r)); // the delta is slow
      const c = cache as { lastKamigazeBlock: number; blockNumber: number };
      c.lastKamigazeBlock = 1000;
      c.blockNumber = 1000;
      return c;
    };
    const worker = start();
    await settle();
    expect(reached).toBe(true);

    // the daemon's pre-LIVE watchdog gives up on this worker and tears it down
    worker.dispose();
    const store = path.join(
      dataDir,
      `ECSCache-${CHAIN}-${WORLD}-v${CACHE_VERSION}.v8snap`
    );
    const before = (await fs.stat(store)).mtimeMs;

    release(); // ...and then its delta lands
    await settle(300);

    expect.soft(h.streams).toHaveLength(0); // no second stream
    expect.soft(h.fillGaps).toHaveLength(0);
    expect.soft((await fs.stat(store)).mtimeMs).toBe(before); // no second writer
  });
});
