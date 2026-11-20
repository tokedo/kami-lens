// 1.2.0: the boot takes the path that needs no logs when its replay window
// would begin below the endpoint's floor.
//
// The REAL SyncWorker (workers/sync/Worker.ts) with its network edges
// scripted, as in test/worker-lifecycle.test.ts — plus a JSON-RPC provider
// that models the endpoint's floor (2026-11-20): eth_getBlockByNumber answers
// null for every block below it and serves the head. A previous run left the
// saved world at block 900; the head is 1010.
//
//   - a warm cache whose replay would start at 901, below a floor at 950, is
//     released: the snapshot service gets an EMPTY cache (the full load);
//   - a CDN image at block 840, below a floor at 850, is declined: the gRPC
//     full load runs instead of the CDN load.
// With the floor below each window the boot is the ordinary one. Synthetic
// blocks throughout.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BehaviorSubject, NEVER, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  floor: 0,
  head: 1010,
  manifest: undefined as undefined | { block: number; nonce: number; prefix: string },
  snapshotCalls: [] as { lastKamigazeBlock: number; size: number }[],
  cdnCalls: 0,
}));

vi.mock('engine/providers', () => ({
  createReconnectingProvider: async () => ({
    providers: {
      get: () => ({
        json: {
          getBlockNumber: async () => h.head,
          // the endpoint: a block below the floor or above the head is null
          _send: async (payload: { id: number; method: string; params: unknown[] }[]) =>
            payload.map((c) => {
              if (c.method !== 'eth_getBlockByNumber') return { jsonrpc: '2.0', id: c.id, result: '0x0' };
              const tag = c.params[0] as string;
              const n = tag === 'latest' ? h.head : parseInt(tag, 16);
              const served = n <= h.head && n >= h.floor;
              return { jsonrpc: '2.0', id: c.id, result: served ? { number: `0x${n.toString(16)}` } : null };
            }),
        },
      }),
    },
    dispose: () => {},
  }),
}));

vi.mock('engine/executors', () => ({
  createBlockNumberStream: () => ({ blockNumber$: new BehaviorSubject(1010), dispose: () => {} }),
}));

vi.mock('workers/sync/snapshot', () => ({
  createSnapshotClient: () => ({}),
  fetchSnapshot: async (cache: { lastKamigazeBlock: number; blockNumber: number; state: Map<unknown, unknown> }) => {
    h.snapshotCalls.push({ lastKamigazeBlock: cache.lastKamigazeBlock, size: cache.state.size });
    cache.lastKamigazeBlock = 1005;
    cache.blockNumber = 1005;
    return cache;
  },
  fetchFromCdn: async () => {
    h.cdnCalls++;
    throw new Error('cdn load ran');
  },
  planCdnLoad: async () => h.manifest,
  isRateLimited: async () => false,
}));

vi.mock('workers/sync/stream', () => ({
  KEEPALIVE_INTERVAL_MS: 10_000,
  HEALTH_CHECK_BUFFER_MS: 2_000,
  markerEvent: (mark: unknown) => ({ txHash: 'mark', appliedMark: mark }),
  createStream: () => NEVER,
  fillGap: async () => [],
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
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kami-lens-floor-'));
  h.snapshotCalls.length = 0;
  h.cdnCalls = 0;
  h.manifest = undefined;
  const cache = state.createStateCache();
  state.storeStateEvent(cache, {
    type: NetworkEvents.NetworkComponentUpdate,
    component: COMPONENT,
    entity: '0x060d' as never,
    value: { value: '0xbeef' },
    blockNumber: 901,
  });
  cache.blockNumber = 900;
  cache.lastKamigazeBlock = 900;
  cache.kamigazeNonce = 5;
  await state.saveStateCacheToStore(await state.getStateStore(CHAIN, WORLD, CACHE_VERSION, dataDir), cache);
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

function start(cdn: boolean) {
  const worker = createSyncWorker(new Subject() as never);
  worker.input$.next({
    type: InputType.Config,
    data: {
      provider: { chainId: CHAIN, jsonRpcUrl: 'http://rpc.invalid', options: { batch: false } },
      worldContract: { address: WORLD, abi: {} as never },
      chainId: CHAIN,
      snapshotServiceUrl: 'https://kamigaze.invalid',
      streamServiceUrl: 'https://kamigaze.invalid',
      ...(cdn ? { stateCdnUrl: 'https://cdn.invalid' } : {}),
      initialBlockNumber: 1,
      dataDir,
      fetchSystemCalls: false,
      reconcileIntervalMs: 120_000,
    } as never,
  });
  return worker;
}
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describe('1.2.0: a warm cache whose replay would begin below the floor is loaded cold', () => {
  it('floor 950 above the cached block 900: the snapshot service gets an empty cache', async () => {
    h.floor = 950;
    const worker = start(false);
    await settle();
    worker.dispose();
    expect(h.snapshotCalls).toEqual([{ lastKamigazeBlock: 0, size: 0 }]);
  });

  it('floor 800 below it: the warm delta from block 900, as before', async () => {
    h.floor = 800;
    const worker = start(false);
    await settle();
    worker.dispose();
    expect(h.snapshotCalls).toEqual([{ lastKamigazeBlock: 900, size: 1 }]);
  });
});

describe('1.2.0: a CDN image older than the floor is declined for the gRPC full load', () => {
  it('image at 840, floor 850: no CDN load, the gRPC load runs', async () => {
    h.floor = 850;
    h.manifest = { block: 840, nonce: 5, prefix: '5/840/x' };
    const worker = start(true);
    await settle();
    worker.dispose();
    expect(h.cdnCalls).toBe(0);
    expect(h.snapshotCalls).toHaveLength(1);
  });

  it('image at 860, floor 850: the CDN load is attempted, as before', async () => {
    h.floor = 850;
    h.manifest = { block: 860, nonce: 5, prefix: '5/860/x' };
    const worker = start(true);
    await settle();
    worker.dispose();
    expect(h.cdnCalls).toBe(1);
  });
});
