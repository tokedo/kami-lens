/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/shapes/Commit/queries.ts
 * changes:  none
 */

import { EntityID, Has, HasValue, QueryFragment, runQuery } from 'engine/recs';

import { Components } from 'network/';

export const queryForHolder = (components: Components, holderID: EntityID, field: string) => {
  const { HolderID, Type, RevealBlock } = components;
  const toQuery: QueryFragment[] = [
    HasValue(HolderID, { value: holderID }),
    HasValue(Type, { value: field }),
    Has(RevealBlock),
  ];
  return Array.from(runQuery(toQuery)).reverse(); // reversed for descending time order
};
