/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Scavenge/getters.ts
 * changes:  none
 */

import { World } from 'engine/recs';
import { Components } from 'network/';
import { queryRegistry } from './queries';
import { get, ScavBar } from './types';

// get a scavenge entity by its type and index
export const getByFieldAndIndex = (
  world: World,
  comps: Components,
  type: string,
  index: number
): ScavBar | undefined => {
  if (!index) return;
  const entity = queryRegistry(world, type, index);
  return entity ? get(world, comps, entity, type, index) : undefined;
};
