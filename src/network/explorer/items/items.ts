/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/explorer/items/items.ts
 * changes:  none
 */

import { EntityIndex, getEntitiesWithValue, World } from 'engine/recs';

import { Components } from 'network/';
import { getAllItems, getItem, getItemByIndex } from 'network/shapes/Item';
import { getWorldBalances } from './stats';

export const items = (world: World, comps: Components) => {
  const { EntityType } = comps;
  return {
    all: () => getAllItems(world, comps).sort((a, b) => a.index - b.index),
    get: (entity: EntityIndex) => getItem(world, comps, entity),
    getByIndex: (index: number) => getItemByIndex(world, comps, index),
    entities: () => Array.from(getEntitiesWithValue(EntityType, { value: 'ITEM' })),
    indices: () => [...new Set(Array.from(comps.ItemIndex.values.value.values()))],
    stats: {
      worldBalances: (index: number, limit = 200, flatten = false) => {
        return getWorldBalances(world, comps, index, limit, flatten);
      },
    },
  };
};
