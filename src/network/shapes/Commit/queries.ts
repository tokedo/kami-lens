/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
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
