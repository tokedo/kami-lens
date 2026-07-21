/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Item/getters.ts
 * changes:  none
 */

import { Has, HasValue, World, runQuery } from 'engine/recs';

import { Components } from 'network/components';
import { DetailedEntity } from '../utils';
import { NullItem } from './constants';
import { queryByIndex } from './queries';
import { Item, getItem, getItemDetails } from './types';

/**
 * get an item in the registry by index
 * @param world - the world object
 * @param components - the list (as object) of registered components in the world
 * @param index - the item index of the registry instance
 */

export const getByIndex = (world: World, components: Components, index: number): Item => {
  const entity = queryByIndex(world, index);
  return entity ? getItem(world, components, entity) : NullItem;
};

export const getDetailsByIndex = (
  world: World,
  components: Components,
  index: number
): DetailedEntity => {
  const entity = queryByIndex(world, index);
  return entity ? getItemDetails(components, entity) : NullItem;
};

// get all items in the registry
export const getAll = (world: World, components: Components): Item[] => {
  const { IsRegistry, EntityType } = components;
  const entityIndices = Array.from(
    runQuery([Has(IsRegistry), HasValue(EntityType, { value: 'ITEM' })])
  );
  return entityIndices.map((entity) => getItem(world, components, entity));
};
