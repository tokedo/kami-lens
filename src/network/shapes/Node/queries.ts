/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/shapes/Node/queries.ts
 * changes:  none
 */

import { EntityID, EntityIndex, World } from 'engine/recs';

import { hashArgs } from '../utils';

// get the entity ID of a Node by its node index
export const indexToID = (index: number): EntityID => {
  return hashArgs(['node', index], ['string', 'uint32']);
};

// query for the entity index of the Node with the given index
export const queryByIndex = (world: World, index: number): EntityIndex => {
  const id = indexToID(index);
  return world.entityToIndex.get(id)!;
};
