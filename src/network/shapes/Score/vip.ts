/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Score/vip.ts
 * changes:  Date.now() → clock.now() at 1 call site plus the
 *           clock import (§3.8: offset-corrected stream clock, not naive
 *           wall clock — see src/clock.ts). Body otherwise verbatim.
 */

import * as clock from 'clock';
import { World } from 'engine/recs';
import { Components } from 'network/components';
import { getConfigFieldValueArray } from '../Config';

// VIP_STAGE: [start, epoch length], hardcoded fallbacks fix race condition loads
const getStageInfo = (world: World, comps: Components) => {
  const stageInfo = getConfigFieldValueArray(world, comps, 'VIP_STAGE');
  return { start: stageInfo[0] || 1746086400, duration: stageInfo[1] || 1209600 };
};

// get the current vip epoch
export const getEpoch = (world: World, comps: Components): number => {
  const now = clock.now() / 1000;
  const { start, duration } = getStageInfo(world, comps);
  return Math.floor((now - start) / duration + 1);
};

// unix seconds when the current vip epoch ends
export const getEpochEnd = (world: World, comps: Components): number => {
  const { start, duration } = getStageInfo(world, comps);
  return start + getEpoch(world, comps) * duration;
};
