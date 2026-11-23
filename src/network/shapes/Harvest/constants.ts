/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Harvest/constants.ts
 * changes:  none
 */

import { EntityID, EntityIndex } from 'engine/recs';
import { NullNode } from '../Node';
import { MULT_PREC } from '../Node/multiplier';
import { Harvest } from './types';

export const NullHarvest: Harvest = {
  id: '0' as EntityID,
  entity: 0 as EntityIndex,
  state: '',
  balance: 0,
  multiplier: MULT_PREC,
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
    output: {
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
