/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/shapes/Scavenge/functions.ts
 * changes:  none
 */

import { EntityID, World } from 'engine/recs';
import { Components } from 'network/';
import { getValue } from '../utils/component';
import { queryInstance } from './queries';

// get the number of points in a scavenge instance
export const getPoints = (
  world: World,
  components: Components,
  type: string,
  scavIndex: number,
  holderID: EntityID
): number => {
  if (!scavIndex) return 0;
  const entity = queryInstance(world, type, scavIndex, holderID);
  return entity ? getValue(components, entity) : 0;
};

export const calcClaimable = (cost: number, points: number): number => {
  return Math.floor(points / cost);
};
