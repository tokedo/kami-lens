/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Kami/battle.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { getKillsForKiller, getKillsForVictim, KillLog } from '../Kill';

export interface Battles {
  kills: KillLog[];
  deaths: KillLog[];
}

// get all kill logs featuring a Kami (by its entity)
export const getBattles = (world: World, components: Components, entity: EntityIndex): Battles => {
  return {
    kills: getKillsForKiller(world, components, entity),
    deaths: getKillsForVictim(world, components, entity),
  };
};
