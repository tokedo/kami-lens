/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/app/cache/inventory/base.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { queryItemByIndex } from 'network/shapes/Item';
import { getItemIndex, getValue } from 'network/shapes/utils/component';
import { getItem } from '../item';

// mapping from an inventory entity to its item entity
const ItemEntityCache = new Map<EntityIndex, EntityIndex>();

// get an inventory from its EnityIndex
// NOTE: inventory itself doesn't really need an explicit cache with only one direct field
export const get = (world: World, components: Components, entity: EntityIndex) => {
  if (!ItemEntityCache.has(entity)) {
    const itemIndex = getItemIndex(components, entity);
    const itemEntity = queryItemByIndex(world, itemIndex);
    if (!!itemEntity) ItemEntityCache.set(entity, itemEntity);
  }
  const itemEntity = ItemEntityCache.get(entity) ?? (0 as EntityIndex);

  return {
    id: world.entities[entity],
    entity,
    balance: getValue(components, entity),
    item: getItem(world, components, itemEntity),
  };
};
