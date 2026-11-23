/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Kill/index.ts
 * changes:  none
 */

export { getForKiller as getKillsForKiller, getForVictim as getKillsForVictim } from './getters';
export {
  queryForKiller as queryKillsForKiller,
  queryForVictim as queryKillsForVictim,
} from './queries';
export { get as getKill } from './types';

export type { KillLog } from './types';
