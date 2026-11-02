/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/shapes/Inventory/getters.ts
 * changes:  none
 */

import { EntityID, World } from 'engine/recs';

import { Components } from 'network/components';
import { Inventory, getInventory } from '../Inventory';
import { query } from './queries';
import { NULL_INVENTORY } from './types';

// gets inventory by deterministic ID using the holder's ID and the item index.
// @returns Inventory. If empty, returns inventory with balance 0
export const getByHolderItem = (
  world: World,
  components: Components,
  holderID: EntityID,
  itemIndex: number
): Inventory => {
  const entities = query(components, { owner: holderID, itemIndex });
  if (!entities) return NULL_INVENTORY;
  return getInventory(world, components, entities[0]);
};
