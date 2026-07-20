import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ComponentValue } from 'engine/recs';
import { FileStateStore } from 'workers/sync/state/store';
import { loadStateCacheFromStore, saveStateCacheToStore, createStateCache, storeStateEvent } from 'workers/sync/state';
import { NetworkEvents } from 'workers/types';
import type { EntityID } from 'engine/recs';

// Swap point 3 (DESIGN §3.5): the file-snapshot StateStore must round-trip a
// StateCache through the upstream loaders verbatim, discard on header
// mismatch, and recover the previous generation when the primary is corrupt.
describe('FileStateStore (swap point 3)', () => {
  let dir: string;
  const header = { chainId: 1337, worldAddress: '0xabc', cacheVersion: 5 };
  const filePath = () => path.join(dir, 'test.v8snap');

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kami-lens-store-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function sampleCache() {
    const cache = createStateCache();
    storeStateEvent(cache, {
      type: NetworkEvents.NetworkComponentUpdate,
      component: '0x4350dba81aa91e31664a09d24a668f006169a11b3d962b7557aed362d3252aec',
      entity: '0x060d' as EntityID,
      value: { value: '0xbeef' } as ComponentValue,
      blockNumber: 101,
    });
    cache.lastKamigazeBlock = 90;
    cache.kamigazeNonce = 7;
    return cache;
  }

  it('round-trips a StateCache through the verbatim loaders', async () => {
    const store = new FileStateStore(filePath(), header);
    const cache = sampleCache();
    await saveStateCacheToStore(store as never, cache);

    const reloaded = new FileStateStore(filePath(), header);
    await reloaded.load();
    const restored = await loadStateCacheFromStore(reloaded as never);
    expect(restored.state.size).toBe(1);
    expect([...restored.state.values()][0]).toEqual({ value: '0xbeef' });
    expect(restored.blockNumber).toBe(100); // storeStateEvent marks one behind
    expect(restored.lastKamigazeBlock).toBe(90);
    expect(restored.kamigazeNonce).toBe(7);
    expect(restored.lastStateValuesBlock).toBe(0); // restored cursor default
  });

  it('discards the snapshot on header mismatch (re-bootstrap semantics)', async () => {
    const store = new FileStateStore(filePath(), header);
    await saveStateCacheToStore(store as never, sampleCache());

    const other = new FileStateStore(filePath(), { ...header, worldAddress: '0xdef' });
    await other.load();
    const restored = await loadStateCacheFromStore(other as never);
    expect(restored.state.size).toBe(0);
    expect(restored.blockNumber).toBe(0);
  });

  it('recovers the previous generation when the primary is corrupt', async () => {
    const store = new FileStateStore(filePath(), header);
    await saveStateCacheToStore(store as never, sampleCache());
    // second save rotates the first snapshot to .prev (set() returns the
    // coalesced flush — awaiting it is exactly one write + rotation)
    await store.set('BlockNumber', 'current', 200);
    // corrupt the primary
    await fs.writeFile(filePath(), Buffer.from('garbage'));

    const recovered = new FileStateStore(filePath(), header);
    await recovered.load();
    expect(await recovered.get('BlockNumber', 'current')).toBe(100);
    expect(await recovered.get('KamigazeNonce', 'current')).toBe(7);
  });

  it('coalesces concurrent sets into one durable snapshot', async () => {
    const store = new FileStateStore(filePath(), header);
    await Promise.all([
      store.set('BlockNumber', 'current', 42),
      store.set('KamigazeNonce', 'current', 3),
      store.set('Mappings', 'components', ['0x0']),
    ]);
    const reloaded = new FileStateStore(filePath(), header);
    await reloaded.load();
    expect(await reloaded.get('BlockNumber', 'current')).toBe(42);
    expect(await reloaded.get('KamigazeNonce', 'current')).toBe(3);
    expect(await reloaded.get('Mappings', 'components')).toEqual(['0x0']);
  });
});
