/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
