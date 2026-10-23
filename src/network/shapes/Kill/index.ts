/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
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
