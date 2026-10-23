/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
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
