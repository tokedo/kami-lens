/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
