/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/shapes/Auction/queries.ts
 * changes:  none
 */

import { HasValue, runQuery } from 'engine/recs';
import { Components } from 'network/components';

export interface Options {
  inputItem?: number;
  outputItem?: number;
}

// query for any auctions meeting certain criteria
export const query = (components: Components, options?: Options) => {
  const { EntityType, CurrencyIndex, ItemIndex } = components;
  const query = [];
  query.push(HasValue(EntityType, { value: 'AUCTION' })); // we don't expect many of these
  if (options?.outputItem !== undefined)
    query.push(HasValue(ItemIndex, { value: options.outputItem }));
  if (options?.inputItem !== undefined)
    query.push(HasValue(CurrencyIndex, { value: options.inputItem }));
  return Array.from(runQuery(query));
};
