/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Conditional/queries.ts
 * changes:  none
 */

import { EntityID, World } from 'engine/recs';
import { Components } from 'network/';
import { genID, queryChildrenOf } from '../utils';
import { Condition, Options, getCondition } from './types';

export function getConditionsOf(
  world: World,
  comps: Components,
  field: string,
  index: number,
  options?: Options
): Condition[] {
  const id = genID(field, index);
  const childEntities = queryChildrenOf(comps, id);
  return childEntities.map((entity) => getCondition(world, comps, entity, options));
}

export function getConditionsOfID(
  world: World,
  comps: Components,
  ptrID: EntityID,
  options?: Options
): Condition[] {
  const childEntities = queryChildrenOf(comps, ptrID);
  return childEntities.map((entity) => getCondition(world, comps, entity, options));
}
