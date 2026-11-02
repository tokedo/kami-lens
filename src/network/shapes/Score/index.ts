/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
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
