/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/explorer/data/data.ts
 * changes:  none
 */

import { EntityID, World } from 'engine/recs';

import { Components } from 'network/';
import { getData, getDataArray } from 'network/shapes/Data';
import { onyx } from './onyx';
import {
  getAuctionBuy,
  getAuctionSpend,
  getGachaMint,
  getGachaReroll,
  getItemUsage,
} from './stats';

export const data = (world: World, components: Components) => {
  return {
    get: (id: EntityID, type: string, index?: number) =>
      getData(world, components, id, type, index),
    getArray: (id: EntityID, type: string, index?: number) =>
      getDataArray(world, components, id, type, index),
    onyx: onyx(world, components),
    stats: {
      auction: {
        buy: (index: number) => getAuctionBuy(world, components, index),
        spend: (index: number) => getAuctionSpend(world, components, index),
      },
      gacha: {
        mint: getGachaMint(world, components),
        reroll: getGachaReroll(world, components),
      },
      item: {
        use: (index: number) => getItemUsage(world, components, index),
        drop: (index: number) => getItemUsage(world, components, index),
      },
    },
  };
};
