/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Score/vip.ts
 * changes:  Date.now() → clock.now() at 1 call site plus the
 *           clock import (§3.8: offset-corrected stream clock, not naive
 *           wall clock — see src/clock.ts). Body otherwise verbatim.
 */

import * as clock from 'clock';
import { World } from 'engine/recs';
import { Components } from 'network/components';
import { getConfigFieldValueArray } from '../Config';

// get the current vip epoch
export const getEpoch = (world: World, comps: Components): number => {
  const now = clock.now() / 1000;
  const stageInfo = getConfigFieldValueArray(world, comps, 'VIP_STAGE');
  const start = stageInfo[0] === 0 ? 1745481600 : stageInfo[0]; // hardcoded to fix race condition loads
  const epochDuration = stageInfo[1] === 0 ? 1209600 : stageInfo[1]; // hardcoded to fix race condition loads
  return Math.floor((now - start) / epochDuration + 1);
};
