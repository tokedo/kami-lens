/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Item/utils.ts
 * changes:  none
 */

import { EntityID } from 'engine/recs';
import { hashArgs } from '../utils';

export const genRefAnchorID = (index: number): EntityID => {
  return hashArgs(['item.usecase', index], ['string', 'uint32']);
};
