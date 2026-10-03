/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/network/shapes/Data/index.ts
 * changes:  none
 */

export { getData, getDataArray } from './types';

export {
  getRenameSpend as getOnyxRenameSpend,
  getRespecSpend as getOnyxRespecSpend,
  getReviveSpend as getOnyxReviveSpend,
  getAll as getOnyxSpends,
} from './onyx';
