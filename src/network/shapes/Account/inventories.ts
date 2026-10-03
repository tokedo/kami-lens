/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/network/shapes/Account/inventories.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/components';
import { getInventory, Inventory } from '../Inventory';
import { query } from '../Inventory/queries';

// query for all Inventory entities owned by an Account entity
export const queryInventories = (world: World, components: Components, entity: EntityIndex) => {
  const id = world.entities[entity];
  return query(components, { owner: id });
};

// get all Inventory objects for an Account entity
export const getInventories = (
  world: World,
  components: Components,
  entity: EntityIndex
): Inventory[] => {
  const entities = queryInventories(world, components, entity);
  return entities.map((entity) => getInventory(world, components, entity));
};
