/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Harvest/constants.ts
 * changes:  none
 */

import { EntityID, EntityIndex } from 'engine/recs';
import { NullNode } from '../Node';
import { Harvest } from './types';

export const NullHarvest: Harvest = {
  id: '0' as EntityID,
  entity: 0 as EntityIndex,
  state: '',
  balance: 0,
  rates: {
    fertility: 0,
    intensity: {
      average: 0,
      spot: 0,
    },
    total: {
      average: 0,
      spot: 0,
    },
  },
  time: {
    last: 0,
    reset: 0,
    start: 0,
  },
  node: NullNode,
};
