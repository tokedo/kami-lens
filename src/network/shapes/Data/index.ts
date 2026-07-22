/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
