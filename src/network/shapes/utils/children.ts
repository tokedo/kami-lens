/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/utils/children.ts
 * changes:  none
 */

import { EntityID, EntityIndex, HasValue, QueryFragment, runQuery } from 'engine/recs';
import { Components } from 'network/';
import { hashArgs } from './IDs';

// libraries for interactions with IDAnchorComponent shapes (children)

/////////////////
// QUERIES

export const queryChildrenOf = (components: Components, anchorID: EntityID): EntityIndex[] => {
  const { AnchorID } = components;
  const toQuery: QueryFragment[] = [HasValue(AnchorID, { value: anchorID })];
  return Array.from(runQuery(toQuery));
};

/////////////////
// UTILS

export const genID = (field: string, index: number): EntityID => {
  return hashArgs([field, index], ['string', 'uint32']);
};
