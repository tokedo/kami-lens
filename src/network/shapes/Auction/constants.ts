/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
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
