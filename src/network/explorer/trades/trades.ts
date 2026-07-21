/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
