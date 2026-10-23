/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
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
