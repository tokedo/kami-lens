/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/shapes/Node/kamis.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { queryHarvestKami } from '../Harvest';
import { queryHarvests } from './harvests';

// query for the Kami entities with active Harvests for a given Node entity
export const queryKamis = (world: World, comps: Components, entity: EntityIndex): EntityIndex[] => {
  const harvestEntities = queryHarvests(world, comps, entity);
  const kamiEntities = harvestEntities.map((harvEntity) =>
    queryHarvestKami(world, comps, harvEntity)
  );
  return kamiEntities;
};
