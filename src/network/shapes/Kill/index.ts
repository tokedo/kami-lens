/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
