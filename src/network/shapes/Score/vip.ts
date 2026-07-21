/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Score/vip.ts
 * changes:  none
 */

import { World } from 'engine/recs';
import { Components } from 'network/components';
import { getConfigFieldValueArray } from '../Config';

// get the current vip epoch
export const getEpoch = (world: World, comps: Components): number => {
  const now = Date.now() / 1000;
  const stageInfo = getConfigFieldValueArray(world, comps, 'VIP_STAGE');
  const start = stageInfo[0] === 0 ? 1745481600 : stageInfo[0]; // hardcoded to fix race condition loads
  const epochDuration = stageInfo[1] === 0 ? 1209600 : stageInfo[1]; // hardcoded to fix race condition loads
  return Math.floor((now - start) / epochDuration + 1);
};
