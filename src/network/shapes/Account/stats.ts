/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/shapes/Account/stats.ts
 * changes:  none
 */

import { MUSU_INDEX } from 'constants/items';
import { EntityIndex, World } from 'engine/recs';
import { Components } from 'network/components';
import { getData } from '../Data';
import { getScoreFromHash, getVIPEpoch } from '../Score';

export interface Stats {
  kills: number;
  coin: number;
  vip: number;
}

export const getStats = (world: World, comps: Components, entity: EntityIndex) => {
  const id = world.entities[entity];
  const vipEpoch = getVIPEpoch(world, comps);
  return {
    kills: getData(world, comps, id, 'LIQUIDATE_TOTAL', 0),
    coin: getData(world, comps, id, 'ITEM_TOTAL', MUSU_INDEX),
    vip: getScoreFromHash(world, comps, id, vipEpoch, 0, 'VIP_SCORE').value,
  };
};
