/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
