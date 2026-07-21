/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
