/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
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
