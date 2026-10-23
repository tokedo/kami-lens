/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/app/cache/kami/calcs/index.ts
 * changes:  re-exports calcSalvage as calcLiqSalvage (visibility-only —
 *           see liquidation.ts header; upstream exports only the
 *           spoils/recoil side of the preview).
 */

export {
  calcCooldown,
  calcCooldownRequirement,
  calcHarvestTime,
  calcHealth,
  calcHealthPercent,
  calcHealthRate,
  canHarvest,
  isDead,
  isFull,
  isHarvesting,
  isOffWorld,
  isResting,
  isStarving,
  isUnrevealed,
  onCooldown,
  updateHealthRate,
} from './base';

export {
  calcHarvestingHealthRate,
  calcOutput,
  calcStrainFromBalance,
  updateHarvestRate,
} from './harvest';

export {
  calcKarma as calcLiqKarma,
  calcRecoil as calcLiqRecoil,
  calcRecoilEfficacy as calcLiqRecoilEfficacy,
  calcSalvage as calcLiqSalvage,
  calcSpoils as calcLiqSpoils,
  calcStrain as calcLiqStrain,
  calcThreshold as calcLiqThreshold,
  canLiquidate,
  canMog,
} from './liquidation';
