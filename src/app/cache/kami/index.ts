/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/app/cache/kami/index.ts
 * changes:  none
 */

export {
  get as getKami,
  invalidateKamiAfterCast,
  invalidateKamiAfterKill,
  invalidateKamiBonuses,
  invalidateKamiFlags,
  invalidateKamiHarvest,
  invalidateKamiLive,
  invalidateKamiStats,
  invalidateKamiTime,
} from './base';
export {
  calcCooldown,
  calcCooldownRequirement,
  calcHarvestTime,
  calcHealth,
  calcHealthPercent,
  calcHealthRate,
  calcLiqKarma,
  calcLiqRecoilEfficacy,
  calcLiqStrain,
  calcLiqThreshold,
  calcOutput,
  calcStrainFromBalance,
  canHarvest,
  canLiquidate,
  canMog,
  isDead,
  isFull,
  isHarvesting,
  isOffWorld,
  isResting,
  isStarving,
  isUnrevealed,
  onCooldown,
  updateHarvestRate,
  updateHealthRate,
} from './calcs';
export {
  getBodyAffinity as getKamiBodyAffinity,
  getHandAffinity as getKamiHandAffinity,
  getRoomIndex as getKamiRoomIndex,
  updateRates,
} from './functions';
export { getKamiAccount, getKamiHarvest, getKamiTraits } from './getters';

export type { Kami } from 'network/shapes/Kami';
export type { RefreshOptions as KamiRefreshOptions } from './base';
