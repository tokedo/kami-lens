/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/app/cache/auction/queries.ts
 * changes:  none
 */

import { EntityIndex } from 'engine/recs';
import { Components } from 'network/components';
import { AuctionOptions, queryAuctions } from 'network/shapes/Auction';

export const CombinedCache = new Map<string, EntityIndex[]>(); // output/input item entity -> auction entity[]
export const InputIndexCache = new Map<number, EntityIndex[]>(); // input item index -> auction entity[]
export const OutputIndexCache = new Map<number, EntityIndex[]>(); // output item index -> auction entity[]

// query for Auction entities while defaulting to the cache
export const query = (components: Components, options?: AuctionOptions) => {
  if (options?.inputItem && options?.outputItem) {
    const key = `${options.inputItem}-${options.outputItem}`;
    if (CombinedCache.has(key)) return CombinedCache.get(key)!;
    else {
      const results = queryAuctions(components, options);
      CombinedCache.set(key, results);
      return results;
    }
  } else if (options?.inputItem) {
    const isCached = InputIndexCache.has(options.inputItem);
    if (isCached) return InputIndexCache.get(options.inputItem)!;
    else {
      const results = queryAuctions(components, options);
      InputIndexCache.set(options.inputItem, results);
      return results;
    }
  } else if (options?.outputItem) {
    const isCached = OutputIndexCache.has(options.outputItem);
    if (isCached) return OutputIndexCache.get(options.outputItem)!;
    else {
      const results = queryAuctions(components, options);
      OutputIndexCache.set(options.outputItem, results);
      return results;
    }
  }
  return queryAuctions(components, options);
};

// a wrapper for query() that assumes just one auction
export const queryOne = (components: Components, options?: AuctionOptions) => {
  const results = query(components, options);
  if (!results || results.length == 0) return 0 as EntityIndex;
  if (results.length > 1) console.warn(`found more than one auction with ${options}`);
  return results[0];
};
