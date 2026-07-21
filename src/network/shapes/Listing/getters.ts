/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Listing/getters.ts
 * changes:  none
 */

import { World } from 'engine/recs';

import { Components } from 'network/components';
import { NullListing } from './constants';
import { query, QueryOptions } from './queries';
import { get, Listing } from './types';

export const getBy = (world: World, comps: Components, options?: QueryOptions): Listing => {
  const results = query(comps, options);
  if (!results || results.length == 0) return NullListing;
  if (results.length > 1) console.warn(`found more than one listing for ${options}`);
  return get(world, comps, results[0]);
};

export const getAll = (world: World, comps: Components): Listing[] => {
  const results = query(comps);
  return results.map((entity) => get(world, comps, entity));
};

export const getByNPC = (world: World, comps: Components, npcIndex: number): Listing[] => {
  const results = query(comps, { npcIndex });
  return results.map((entity) => get(world, comps, entity));
};

export const getByItem = (world: World, comps: Components, itemIndex: number): Listing[] => {
  const results = query(comps, { itemIndex });
  return results.map((entity) => get(world, comps, entity));
};
