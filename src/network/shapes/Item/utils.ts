/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/shapes/Item/utils.ts
 * changes:  none
 */

import { EntityID } from 'engine/recs';
import { hashArgs } from '../utils';

export const genRefAnchorID = (index: number): EntityID => {
  return hashArgs(['item.usecase', index], ['string', 'uint32']);
};
