/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
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
