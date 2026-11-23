/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
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
