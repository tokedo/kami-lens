// A3 — the boot window is chain-verified too.
//
// A warm boot, a CDN cold boot's bridge, and every 10-minute checkpoint run
// the ported incremental snapshot fetch (workers/sync/snapshot/fetch.ts):
// GetStateBlock, then GetComponents, GetState(removals), GetState(values),
// GetEntities — five calls against a service with no stickiness between
// them. The cache is then stamped with the block the FIRST call named. A
// later call served by a replica behind that block leaves the cache claiming
// blocks it never read, and the checkpoint PERSISTS the claim. Everything the
// boot later reads from the chain starts from that stamp, and the reconcile
// baseline is seeded at the stream's start, so nothing below it is ever
// re-read.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { VERSION as CACHE_VERSION } from 'cache/db';
import type { KamigazeServiceClient } from 'clients/kamigaze';
import { createDecode } from 'engine/encoders';
import type { EntityID } from 'engine/recs';
import { runCheckpointJob } from 'workers/checkpoint/job';
import { fetchSnapshot } from 'workers/sync/snapshot';
import {
  createStateCache,
  getStateStore,
  loadStateCacheFromStore,
  saveStateCacheToStore,
  storeStateEvent,
  type StateCache,
} from 'workers/sync/state';
import { NetworkEvents } from 'workers/types';

const COMPONENT = '0x4350dba81aa91e31664a09d24a668f006169a11b3d962b7557aed362d3252aec';

/** A cache a previous run left at block 900, nonce 5. */
function cacheAt(block: number): StateCache {
  const cache = createStateCache();
  storeStateEvent(cache, {
    type: NetworkEvents.NetworkComponentUpdate,
    component: COMPONENT,
    entity: '0x060d' as EntityID,
    value: { value: '0xbeef' },
    blockNumber: block,
  });
  cache.blockNumber = block;
  cache.lastKamigazeBlock = block;
  cache.kamigazeNonce = 5;
  return cache;
}

/** GetStateBlock answers from a replica at 1000; the GetState streams that
 * follow are served by one at 990 — the last block whose values it holds. */
function splitReplicaClient(): KamigazeServiceClient {
  const one = <T>(chunk: T) =>
    (async function* () {
      yield chunk;
    })();
  return {
    getStateBlock: async () => ({ blockNumber: 1000, nonce: 5 }),
    getComponents: async () => ({ components: [] }),
    getState: ({ removals }: { removals?: boolean }) =>
      one({ state: [], pending: 0, lastBlockNumber: removals ? 0 : 990 }),
    getEntities: () => one({ entities: [], pending: 0 }),
  } as unknown as KamigazeServiceClient;
}

const delta = (cache: StateCache) =>
  fetchSnapshot(cache, splitReplicaClient(), createDecode(), 10, () => {}, () => {});

describe('A3: the snapshot delta never stamps a block it did not read', () => {
  it('values served through 990 do not yield a cache stamped 1000', async () => {
    const out = await delta(cacheAt(900));
    expect.soft(out.lastKamigazeBlock).toBeLessThanOrEqual(990);
    expect.soft(out.blockNumber).toBeLessThanOrEqual(990);
  });

  it('the checkpoint child does not PERSIST a stamp newer than its data', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kami-lens-a3-'));
    try {
      const store = await getStateStore(1337, '0xabc', CACHE_VERSION, dataDir);
      await saveStateCacheToStore(store, cacheAt(900));
      await runCheckpointJob(
        {
          chainId: 1337,
          worldAddress: '0xabc',
          cacheVersion: CACHE_VERSION,
          dataDir,
          kamigazeUrl: 'https://kamigaze.invalid',
          snapshotNumChunks: 10,
        },
        { refresh: (cache) => delta(cache) }
      );
      const persisted = await loadStateCacheFromStore(
        await getStateStore(1337, '0xabc', CACHE_VERSION, dataDir)
      );
      expect.soft(persisted.lastKamigazeBlock).toBeLessThanOrEqual(990);
      expect.soft(persisted.blockNumber).toBeLessThanOrEqual(990);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
