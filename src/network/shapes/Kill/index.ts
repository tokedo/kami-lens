/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
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
