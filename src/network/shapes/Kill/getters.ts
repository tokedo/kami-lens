/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/shapes/Kill/getters.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { queryForKiller, queryForVictim } from './queries';
import { KillLog, get } from './types';

// get Kill Log objects for a Kami (by entity) where it performed a kill
export const getForKiller = (
  world: World,
  components: Components,
  entity: EntityIndex
): KillLog[] => {
  const results = queryForKiller(world, components, entity);
  return results.map((killEntity) => get(world, components, killEntity));
};

// get Kill Logs objects for a Kami (by entity) where it died
export const getForVictim = (
  world: World,
  components: Components,
  entity: EntityIndex
): KillLog[] => {
  const results = queryForVictim(world, components, entity);
  return results.map((killEntity) => get(world, components, killEntity));
};
