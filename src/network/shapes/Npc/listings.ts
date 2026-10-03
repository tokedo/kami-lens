/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/network/shapes/Npc/listings.ts
 * changes:  none
 */

import { World } from 'engine/recs';

import { Components } from 'network/components';
import { Listing, getListing, queryNPCListings } from '../Listing';

export const getListings = (world: World, comps: Components, npcIndex: number): Listing[] => {
  const entities = queryNPCListings(comps, npcIndex);
  return entities.map((entity) => getListing(world, comps, entity));
};
