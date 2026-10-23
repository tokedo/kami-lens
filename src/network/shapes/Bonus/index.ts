/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/shapes/Bonus/index.ts
 * changes:  none
 */

export { getBonusValue, getBonusesByParent } from './getters';
export { parseBonusText } from './interpretation';
export {
  queryForEndType as queryBonusForEndType,
  queryForParent as queryBonusForParent,
  queryForType as queryBonusForType,
} from './queries';
export {
  genEndAnchor as genBonusEndAnchor,
  genTypeID as genBonusTypeID,
  getRegistry as getBonusRegistry,
} from './types';

export type { Bonus, BonusInstance } from './types';
