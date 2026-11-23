/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
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
