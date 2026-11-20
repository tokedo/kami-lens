/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/network/shapes/Allo/getters.ts
 * changes:  none
 */

import { EntityID, EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { Allo, getAllo } from '.';
import { queryChildrenOf } from '../utils';

export const getAllosOf = (world: World, comps: Components, anchorID: EntityID): Allo[] => {
  const childEntities = queryChildrenOf(comps, anchorID);
  return childEntities.map((entity: EntityIndex) => getAllo(world, comps, entity));
};
