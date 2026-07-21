/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/utils/index.ts
 * changes:  none
 */

export { getCompAddr, getSystemAddr } from './addresses';
export { genID, queryChildrenOf } from './children';
export { getBalance, getBool, getInventoryBalance } from './getter';
export { getEntityByHash, hashArgs } from './IDs';
export {
  getAffinityImage,
  getFactionImage,
  getItemImage,
  getSkillImage,
  getStatImage,
} from './images';
export { unpackArray32 } from './packing';
export {
  getFromDescription,
  parseKamiStateFromIndex,
  parseKamiStateToIndex,
  parseQuantity,
  parseQuantityStat,
  parseStatTypeFromIndex,
} from './parse';
export { genRef, queryRefChildren, queryRefsWithParent } from './references';

export { capitalize } from './strings';

export type { DetailedEntity } from './parse';
