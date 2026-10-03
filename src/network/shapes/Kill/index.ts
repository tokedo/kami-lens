/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
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
