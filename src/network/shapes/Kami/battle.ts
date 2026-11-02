/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
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
