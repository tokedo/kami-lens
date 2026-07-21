/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/app/cache/harvest/getters.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/components';
import { getSourceID } from 'network/shapes/utils/component';
import { getNode } from '../node';

// get the Node object for a Harvest entity
export const getHarvestNode = (world: World, comps: Components, entity: EntityIndex) => {
  const nodeID = getSourceID(comps, entity);
  const nodeEntity = world.entityToIndex.get(nodeID) as EntityIndex;
  if (!nodeEntity) console.warn(`node not found for harvest entity ${entity}`);
  return getNode(world, comps, nodeEntity);
};
