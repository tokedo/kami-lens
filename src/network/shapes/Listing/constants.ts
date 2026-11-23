/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
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
