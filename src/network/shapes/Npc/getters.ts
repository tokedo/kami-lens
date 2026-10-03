/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/network/shapes/Npc/getters.ts
 * changes:  none
 */

import { World } from 'engine/recs';

import { Components } from 'network/components';
import { NullNPC } from './constants';
import { query, queryByIndex } from './queries';
import { get, Options } from './types';

export const getAll = (world: World, comps: Components, options?: Options) => {
  const entities = query(comps);
  return entities.map((entity) => get(world, comps, entity, options));
};

// the Merchant Index here is actually an NPCIndex
export const getByIndex = (world: World, comps: Components, index: number, options?: Options) => {
  const entity = queryByIndex(world, comps, index);
  if (!entity) return NullNPC;
  return get(world, comps, entity, options);
};
