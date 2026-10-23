/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
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
