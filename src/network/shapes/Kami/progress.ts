/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/shapes/Kami/progress.ts
 * changes:  1.1.0 (§3.19) — calcExperienceRequirement computes the chain's
 *           integer arithmetic instead of a float power: LibExperience
 *           .calcLevelCost, `(base * powWad(1e18·mult/10^prec, (level−1)·1e18))
 *           / 1e18` with Solady's powWad (utils/fixed-point). The float
 *           `Math.pow` read one XP low from level 119 (≥ 2.5e13 XP). A power
 *           the chain cannot compute (it reverts) keeps the float value.
 *           Body otherwise verbatim.
 */

import { EntityIndex, World } from 'engine/recs';
import { WAD, powWad } from 'utils/fixed-point';
import { Components } from 'network/components';
import { getConfigFieldValue, getConfigFieldValueArray } from '../Config';
import { getExperience, getLevel } from '../utils/component';

export interface Progress {
  level: number;
  experience: number;
}

export const getProgress = (components: Components, entity: EntityIndex): Progress => {
  return {
    level: getLevel(components, entity, 1),
    experience: getExperience(components, entity),
  };
};

// experience threshold calculation according to level
// TODO: lazily evaluate this rather than saving it directly to object
export const calcExperienceRequirement = (
  world: World,
  components: Components,
  level: number
): number => {
  const experienceBase = getConfigFieldValue(world, components, 'KAMI_LVL_REQ_BASE');
  const expereinceExponentArr = getConfigFieldValueArray(
    world,
    components,
    'KAMI_LVL_REQ_MULT_BASE'
  );
  const experienceExponent = expereinceExponentArr[0];
  const exponentPrecision = 10 ** expereinceExponentArr[1];
  // kami-lens (1.1.0): LibExperience.calcLevelCost in the chain's own integers
  try {
    if (level <= 1) return Math.floor(experienceBase);
    const multiplierBase = (WAD * BigInt(experienceExponent)) / 10n ** BigInt(expereinceExponentArr[1]);
    const multiplier = powWad(multiplierBase, BigInt(level - 1) * WAD);
    return Number((BigInt(Math.trunc(experienceBase)) * multiplier) / WAD);
  } catch {
    // the chain reverts here (a zero multiplier, an exponent past expWad's range)
  }
  return Math.floor(
    experienceBase * ((1.0 * experienceExponent) / exponentPrecision) ** (level - 1)
  );
};
