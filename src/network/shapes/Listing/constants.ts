/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Listing/constants.ts
 * changes:  one @ts-expect-error — upstream type defect at the pin (vite
 *           never typechecks): NullListing.buy carries a `currency` field the
 *           Pricing type does not declare. Body otherwise verbatim.
 */

import { EntityID, EntityIndex } from 'engine/recs';
import { NullItem } from '../Item';
import { Listing } from './types';

export const NullListing: Listing = {
  id: '0' as EntityID,
  entity: 0 as EntityIndex,
  item: NullItem,
  value: 0,
  balance: 0,
  startTime: 0,
  requirements: [],
  buy: {
    // @ts-expect-error upstream defect at the pin: `currency` not in Pricing
    currency: NullItem, // musu
    type: 'FIXED',
  },
};
