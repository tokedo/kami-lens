/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
