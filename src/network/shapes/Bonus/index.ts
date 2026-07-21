/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
