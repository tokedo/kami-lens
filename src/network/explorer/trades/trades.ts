/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
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
