/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Auction/constants.ts
 * changes:  none
 */

import { EntityID, EntityIndex } from 'engine/recs';
import { Auction } from './types';

export const NullAuction: Auction = {
  id: '0' as EntityID,
  entity: 0 as EntityIndex,
  ObjectType: 'AUCTION',
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
    pause: { start: 0, end: 0 },
  },
};
