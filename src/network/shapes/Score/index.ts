/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
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
export { getEpoch as getVIPEpoch, getEpochEnd as getVIPEpochEnd } from './vip';

export type { Score, ScoresFilter } from './types';
