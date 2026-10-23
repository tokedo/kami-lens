/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/shapes/Kami/harvest.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { getHarvest as getHarvestShape, Harvest } from '../Harvest';
import { getEntityByHash } from '../utils';

// query the Harvest entity for a Kami entity
export const queryHarvest = (world: World, entity: EntityIndex) => {
  const id = world.entities[entity];
  return getEntityByHash(world, ['harvest', id], ['string', 'uint256']);
};

// get the Harvest object for a Kami entity
export const getHarvest = (
  world: World,
  components: Components,
  entity: EntityIndex // kami entity index
): Harvest | undefined => {
  const harvestEntity = queryHarvest(world, entity);
  if (!harvestEntity) return undefined;
  return getHarvestShape(world, components, harvestEntity, { node: true });
};
