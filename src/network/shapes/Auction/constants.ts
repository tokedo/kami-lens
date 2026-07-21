/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Auction/constants.ts
 * changes:  one @ts-expect-error — upstream type defect at the pin (vite
 *           never typechecks): NullAuction carries an `items` block the
 *           Auction type does not declare. Body otherwise verbatim.
 */

import { EntityID, EntityIndex } from 'engine/recs';
import { Auction } from './types';

export const NullAuction: Auction = {
  id: '0' as EntityID,
  entity: 0 as EntityIndex,
  ObjectType: 'AUCTION',
  // @ts-expect-error upstream defect at the pin: `items` not in Auction type
  items: {
    outIndex: 0,
    inIndex: 0,
  },
  params: {
    value: 0,
    period: 0,
    decay: 0,
    rate: 0,
  },
  supply: {
    sold: 0,
    total: 0,
  },
  time: {
    start: 0,
  },
};
