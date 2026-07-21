/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
