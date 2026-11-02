/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/explorer/listings/listings.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { getAllListings, getItemListings, getListing, getListingBy } from 'network/shapes/Listing';
import { getNPCListings } from 'network/shapes/Npc';

export const listings = (world: World, comps: Components) => {
  return {
    all: () => getAllListings(world, comps),
    get: (entity: EntityIndex) => getListing(world, comps, entity),
    getByNPC: (index: number) => getNPCListings(world, comps, index),
    getByItem: (index: number) => getItemListings(world, comps, index),
    getBy: (itemIndex: number, npcIndex: number) =>
      getListingBy(world, comps, { itemIndex, npcIndex }),
  };
};
