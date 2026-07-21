/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Item/functions.ts
 * changes:  none
 */

import { EntityID, EntityIndex, World, getComponentValue } from 'engine/recs';

import { MUSU_INDEX } from 'constants/items';
import { Components } from 'network/index';
import { queryInventoryInstance } from '../Inventory';

/////////////////
// GETTERS
// TODO: move these to.. app/cache/inventory/helpers.ts?

// get the MUSU balance of a holder entity
export const getMusuBalance = (
  world: World,
  components: Components,
  entity: EntityIndex
): number => {
  const id = world.entities[entity];
  return getItemBalance(world, components, id, MUSU_INDEX);
};

// TODO: make this an Inventory function
export const getItemBalance = (
  world: World,
  components: Components,
  holderID: EntityID,
  itemIndex: number
): number => {
  const { Value } = components;
  const entity = queryInventoryInstance(world, holderID ?? 0, itemIndex);
  return entity ? (getComponentValue(Value, entity)?.value ?? 0) * 1 : 0;
};
