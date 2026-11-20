/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/network/shapes/Listing/constants.ts
 * changes:  none
 */

import { EntityID, EntityIndex } from 'engine/recs';
import { NullItem } from '../Item';
import { Listing } from './types';

export const NullListing: Listing = {
  id: '0' as EntityID,
  entity: 0 as EntityIndex,
  item: NullItem,
  payItem: NullItem,
  value: 0,
  balance: 0,
  startTime: 0,
  requirements: [],
  buy: {
    type: 'FIXED',
  },
};
