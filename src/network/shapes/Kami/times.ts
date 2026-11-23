/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Kami/times.ts
 * changes:  none
 */

import { EntityIndex } from 'engine/recs';

import { Components } from 'network/';
import { getLastTime, getNextTime, getStartTime } from '../utils/component';

export interface Times {
  cooldown: number;
  last: number;
  start: number;
}

// populate the time-tracking fields of a kami
export const getTimes = (comps: Components, entity: EntityIndex): Times => {
  return {
    cooldown: getNextTime(comps, entity),
    last: getLastTime(comps, entity),
    start: getStartTime(comps, entity),
  };
};
