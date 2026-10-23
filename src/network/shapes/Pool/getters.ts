/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/shapes/Pool/getters.ts
 * changes:  none
 */

import { World } from 'engine/recs';

import { Components } from 'network/';
import { query } from './queries';
import { genPoolEntity, get, Pool } from './types';

export const getAll = (world: World, comps: Components): Pool[] => {
  return query(comps).map((entity) => get(world, comps, entity));
};

// get a pool by its item pair (order-insensitive)
export const getByItems = (
  world: World,
  comps: Components,
  indexA: number,
  indexB: number
): Pool | undefined => {
  const entity = genPoolEntity(world, indexA, indexB);
  return entity ? get(world, comps, entity) : undefined;
};
