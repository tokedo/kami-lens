/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/shapes/Trade/queries.ts
 * changes:  none
 */

import { EntityID, EntityIndex, Has, HasValue, QueryFragment, runQuery } from 'engine/recs';

import { Components } from 'network/';

export type QueryOptions = {
  sellerID?: EntityID;
};

export const query = (components: Components, options?: QueryOptions): EntityIndex[] => {
  const { OwnsTradeID } = components;
  const toQuery: QueryFragment[] = [];

  if (options?.sellerID != undefined)
    toQuery.push(HasValue(OwnsTradeID, { value: options.sellerID }));
  toQuery.push(Has(OwnsTradeID)); // only trades have OwnsTradeID

  const results = runQuery(toQuery);
  return Array.from(results);
};
