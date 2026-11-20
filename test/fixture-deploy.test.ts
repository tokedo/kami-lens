// 1.2.0: the gates' fixture loader applies the multiplier deploy's K = 1000
// ONLY to a fixture that holds no HarvestMultiplier row at all — a fixture
// taken after the deploy keeps its own K, every one.

import { describe, expect, it } from 'vitest';

import { formatComponentID } from 'engine/utils';
import type { EntityID } from 'engine/recs';
import { createStateCache, storeStateEvent } from 'workers/sync/state';
import { NetworkEvents } from 'workers/types';
import { HARVEST_MULTIPLIER_ID, NODE_INDEX_ID, withHarvestMultiplierDeploy } from '../gates/g1/fixture-deploy.mts';

const put = (cache: ReturnType<typeof createStateCache>, component: string, entity: string, value: unknown) =>
  storeStateEvent(cache, {
    type: NetworkEvents.NetworkComponentUpdate,
    component,
    entity: entity as EntityID,
    value: { value } as never,
    blockNumber: 10,
  });
const valueOf = (cache: ReturnType<typeof createStateCache>, component: string, entity: string) => {
  const c = cache.componentToIndex.get(component);
  const e = cache.entityToIndex.get(entity);
  if (c === undefined || e === undefined) return undefined;
  for (const [k, v] of cache.state) if (k >>> 24 === c && (k & 0xffffff) === e) return (v as { value: unknown }).value;
  return undefined;
};
const HM = formatComponentID(HARVEST_MULTIPLIER_ID);

describe('1.2.0: the fixture loader\'s K injection', () => {
  it('a fixture with nodes and no HarvestMultiplier row: K = 1000 on every node, nothing else', () => {
    const cache = createStateCache();
    put(cache, NODE_INDEX_ID, '0xab', 1);
    put(cache, NODE_INDEX_ID, '0xcd', 2);
    withHarvestMultiplierDeploy(cache);
    expect(valueOf(cache, HM, '0xab')).toBe('0x3e8');
    expect(valueOf(cache, HM, '0xcd')).toBe('0x3e8');
  });

  it('a fixture that holds ANY HarvestMultiplier row is left exactly as it is', () => {
    const cache = createStateCache();
    put(cache, NODE_INDEX_ID, '0xab', 1);
    put(cache, NODE_INDEX_ID, '0xcd', 2);
    put(cache, HM, '0xab', '0x7d0'); // node a's own K, 2.0; node b has none
    const size = cache.state.size;
    withHarvestMultiplierDeploy(cache);
    expect(cache.state.size).toBe(size);
    expect(valueOf(cache, HM, '0xab')).toBe('0x7d0');
    expect(valueOf(cache, HM, '0xcd')).toBeUndefined();
  });
});
