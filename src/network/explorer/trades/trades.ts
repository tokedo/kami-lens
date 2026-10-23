/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/explorer/trades/trades.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';
import { Components } from 'network/components';
import { get, getAll, getByType } from './utils';

export const trades = (world: World, comps: Components) => {
  return {
    all: () => getAll(world, comps),
    allForType: (type: string) => getByType(world, comps, type),
    get: (entity: EntityIndex) => get(world, comps, entity),
  };
};
