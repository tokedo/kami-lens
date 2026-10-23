/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/shapes/Bonus/getters.ts
 * changes:  none
 */

import { EntityID, World } from 'engine/recs';
import { Components } from 'network/';
import { queryForParent, queryForType } from './queries';
import { Bonus, getRegistry, getValue } from './types';

export const getBonusValue = (
  world: World,
  components: Components,
  field: string,
  holderID: EntityID,
  precision: number = 0
): number => {
  const values = getBonusValuesForType(world, components, field, holderID, precision);
  return values.reduce((sum, curr) => sum + curr, 0);
};

export const getBonusValuesForType = (
  world: World,
  components: Components,
  field: string,
  holderID: EntityID,
  precision: number = 0
): number[] => {
  const entities = queryForType(components, field, holderID);
  return entities.map((entity) => getValue(world, components, entity, precision));
};

export const getBonusesByParent = (
  world: World,
  components: Components,
  anchorID: EntityID
): Bonus[] => {
  const entities = queryForParent(components, anchorID);
  return entities.map((entity) => getRegistry(world, components, entity));
};
