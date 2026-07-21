/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Score/index.ts
 * changes:  none
 */

export {
  get as getScore,
  getFromHash as getScoreFromHash,
  getByFilter as getScoresByFilter,
  getByType as getScoresByType,
  getTotalByFilter as getTotalScoreByFilter,
} from './types';
export { getEpoch as getVIPEpoch } from './vip';

export type { Score, ScoresFilter } from './types';
