/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Item/utils.ts
 * changes:  none
 */

import { EntityID } from 'engine/recs';
import { hashArgs } from '../utils';

export const genRefAnchorID = (index: number): EntityID => {
  return hashArgs(['item.usecase', index], ['string', 'uint32']);
};
