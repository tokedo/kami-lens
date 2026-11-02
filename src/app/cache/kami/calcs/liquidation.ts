/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/app/cache/kami/calcs/liquidation.ts
 * changes:  calcSalvage exported (upstream keeps it module-private; its UI
 *           previews only spoils/recoil). Visibility-only; the query surface
 *           serves the salvage side of the liquidation preview through it.
 *           1.1.0 (§3.19) — every calc here computes the chain's integers
 *           (LibKill at the pin), not floats:
 *           - calcAnimosity (now animosityUnits, integer) / calcKarma:
 *             Gaussian.cdf(lnWad(1e18·a/b)) — the
 *             contracts' own fixed-point cdf (utils/fixed-point), not
 *             @stdlib's — times the ratio, floored at ANIMOSITY_PREC (1e-6)
 *             and KARMA_PREC (1e-3). The client did not floor karma, so the
 *             recoil read up to ⌈strain/1000⌉ HP high.
 *           - calcThreshold: `(animosity · efficacy + shift · 10^(6+c3−c5)) ·
 *             healthTotal / 10^(6+c3+c7)`, the efficacy floored at 0
 *             (calcThresholdEfficacy); the client's extra `config[4]` shift
 *             term, which the chain never reads, is dropped.
 *           - calcRecoil: `((karma + efficacy) · strain · boost) /
 *             10^(c1+c3+c7)`, boost floored at 0.
 *           - calcSalvage / calcSpoils (shareOf): ratio = c2 + (c0 + power) ·
 *             10^(c3−c1) + bonus; `ratio / 10^c3 > 1` in INTEGER division
 *             pays the whole amount, otherwise `amt · ratio / 10^c3`. The
 *             client capped spoils at min(1, ratio) (the chain pays up to
 *             1.99× for a ratio in (1, 2)) and never capped salvage; it
 *             hard-coded power/100 where the chain scales by 10^(c3−c1).
 *             Spoils of a negative remainder (salvage above the bounty: the
 *             chain's liquidation reverts) are 0.
 *           Efficacy shifts and bonuses are read back to raw values at the
 *           target's precision (the chain adds raw slots); equal while the
 *           efficacy configs' precision slot equals it (3, live).
 */

import { Kami } from 'network/shapes/Kami';
import { gaussianShare } from 'utils/fixed-point';
import { calcHealth, isStarving, onCooldown } from './base';
import { calcOutput, calcStrainFromBalance } from './harvest';

// kami-lens (1.1.0): a scaled bonus or efficacy back to its raw value
const toRaw = (x: number | undefined, precision: number): number =>
  Math.round((x ?? 0) * 10 ** precision);

const ANIMOSITY_PREC = 6;
const KARMA_PREC = 3;

// calculate the affinity multiplier for liquidation threshold
const calcEfficacy = (attacker: Kami, defender: Kami): number => {
  const config = attacker.config ?? defender.config;
  if (!config) return 0;

  const threshConfig = config.liquidation.threshold;
  const effConfig = config.liquidation.efficacy;
  const attBonus = attacker.bonuses?.attack.threshold.ratio ?? 0;
  const defBonus = defender.bonuses?.defense.threshold.ratio ?? 0;

  const base = threshConfig.ratio.value;
  const shiftNeut = effConfig.base;
  const shiftUp = effConfig.up + attBonus - defBonus;
  const shiftDown = effConfig.down;
  const shiftSpec = effConfig.special + attBonus - defBonus;

  let shift = shiftNeut;
  if (attacker.traits && defender.traits) {
    const attAffinity = attacker.traits.hand.affinity;
    const defAffinity = defender.traits.body.affinity;

    if (attAffinity === 'EERIE') {
      if (defAffinity === 'SCRAP') shift = shiftUp;
      else if (defAffinity === 'INSECT') shift = shiftDown;
    } else if (attAffinity === 'SCRAP') {
      if (defAffinity === 'INSECT') shift = shiftUp;
      else if (defAffinity === 'EERIE') shift = shiftDown;
    } else if (attAffinity === 'INSECT') {
      if (defAffinity === 'EERIE') shift = shiftUp;
      else if (defAffinity === 'SCRAP') shift = shiftDown;
    } else if (attAffinity === 'NORMAL') {
      if (defAffinity === 'NORMAL') shift = shiftSpec;
    }
  }

  return base + shift;
};

// calculate the base liquidation threshold % between two kamis
// kami-lens (1.1.0): LibKill.calcAnimosity in ANIMOSITY_PREC units
const animosityUnits = (attacker: Kami, defender: Kami): bigint => {
  const attViolence = attacker.stats?.violence.total ?? 1;
  const defHarmony = defender.stats?.harmony.total ?? 1;
  const config = attacker.config ?? defender.config;
  if (!config) return 0n;
  const ratio = config.liquidation.animosity.ratio;
  return gaussianShare(attViolence, defHarmony, ratio.raw, ratio.precision, ANIMOSITY_PREC);
};

// calculate the liquidation threshold b/w two kamis
// kami-lens (1.1.0): LibKill.calcThreshold in the chain's integers
export const calcThreshold = (attacker: Kami, defender: Kami): number => {
  const config = attacker.config ?? defender.config;
  if (!config) return 0;
  const c = config.liquidation.threshold;
  const attShift = toRaw(attacker.bonuses?.attack.threshold.shift, 3);
  const defShift = toRaw(defender.bonuses?.defense.threshold.shift, 3);

  const base = animosityUnits(attacker, defender);
  // calcThresholdEfficacy: the ratio slot plus the shift, floored at 0
  const ratio = Math.max(0, toRaw(calcEfficacy(attacker, defender), c.ratio.precision));
  const shiftPrec = 10n ** BigInt(ANIMOSITY_PREC + c.ratio.precision - c.shift.precision);
  const shift = BigInt(attShift - defShift) * shiftPrec;
  const post = base * BigInt(ratio) + shift;
  if (post < 0n) return 0;
  const health = BigInt(Math.trunc(defender.stats?.health.total ?? 0));
  return Number((post * health) / 10n ** BigInt(ANIMOSITY_PREC + c.ratio.precision + c.boost.precision));
};

// kami-lens (1.1.0): LibKill.calcSalvage / calcSpoils — one body
const shareOf = (
  config: { nudge: { raw: number; precision: number }; ratio: { raw: number; precision: number } },
  power: number,
  bonusRaw: number,
  amount: number
): number => {
  const amt = Math.trunc(amount);
  if (amt <= 0) return 0;
  const tuneExp = config.ratio.precision - config.nudge.precision;
  if (tuneExp < 0) return 0; // the chain's 10 ** (c3 − c1) underflows: it reverts
  const powerTuning = BigInt(config.nudge.raw + Math.trunc(power)) * 10n ** BigInt(tuneExp);
  const ratio = BigInt(config.ratio.raw) + powerTuning + BigInt(bonusRaw);
  const precision = 10n ** BigInt(config.ratio.precision);
  if (ratio / precision > 1n) return amt;
  return Number((BigInt(amt) * ratio) / precision);
};

// calculate the salvage of a kami having its current harvest liquidated
// (kami-lens: exported for the query surface's liquidation preview —
// visibility-only change, formula untouched; upstream keeps it private
// because its UI shows only spoils/recoil)
export const calcSalvage = (kami: Kami, balance?: number): number => {
  if (!kami.harvest) return 0;
  if (!kami.config) return 0;

  const config = kami.config.liquidation.salvage;
  const ratioBonus = toRaw(kami.bonuses?.defense.salvage.ratio, 3);
  const power = kami.stats?.power.total ?? 0;

  if (!balance) balance = calcOutput(kami);
  // kami-lens (1.1.0): the chain's integers (shareOf)
  return shareOf(config, power, ratioBonus, balance);
};

// calculate the spoils of one kami from liquidating another kami
export const calcSpoils = (attacker: Kami, defender: Kami): number => {
  if (!defender.harvest) return 0;
  if (!attacker.config) return 0;

  const config = attacker.config.liquidation.spoils;
  const ratioBonus = toRaw(attacker.bonuses?.attack.spoils.ratio, 3);
  const power = attacker.stats?.power.total ?? 0;

  const balance = calcOutput(defender);
  const salvage = calcSalvage(defender, balance);
  // kami-lens (1.1.0): the chain's integers (shareOf) on what the salvage
  // leaves; a negative remainder (the chain reverts) has no spoils
  return shareOf(config, power, ratioBonus, balance - salvage);
};

// calculate the strain of one kami from liquidating another kami
export const calcStrain = (attacker: Kami, defender: Kami): number => {
  const harvest = defender.harvest;
  if (!harvest) return 0;

  const spoils = calcSpoils(attacker, defender);
  return calcStrainFromBalance(attacker, spoils, true);
};

// calculate Karma — Gaussian-based combat multiplier for recoil (PR #2384)
// uses the same CDF curve as calcAnimosity but with defender's violence vs attacker's harmony.
// old formula was linear (v2 - h1 + nudge); new formula is smooth (Gaussian CDF of log ratio).
// result is a multiplier (~0 to karma.ratio.value), NOT raw HP damage.
export const calcKarma = (attacker: Kami, defender: Kami): number => {
  const config = attacker.config ?? defender.config;
  if (!config) return 0;

  const karmaConfig = config.liquidation.karma;
  const defViolence = defender.stats?.violence.total ?? 1;
  const attHarmony = attacker.stats?.harmony.total ?? 1;

  // kami-lens (1.1.0): LibKill.calcKarma — the contracts' cdf, floored at
  // KARMA_PREC (1e-3); the client kept the unfloored product
  const ratio = karmaConfig.ratio; // karma range (e.g. 2.0 from config [0, 0, 2000, 3, ...])
  return Number(gaussianShare(defViolence, attHarmony, ratio.raw, ratio.precision, KARMA_PREC)) / 10 ** KARMA_PREC;
};

// calculate the affinity-based efficacy nudge applied to recoil (PR #2384)
// mirrors calcEfficacy but uses defender's HAND vs attacker's BODY (opposite direction),
// and reads from KAMI_LIQ_KARMA_EFFICACY config instead of KAMI_LIQ_EFFICACY.
// advantage = defender's hand beats attacker's body → more recoil on the attacker.
export const calcRecoilEfficacy = (attacker: Kami, defender: Kami, baseEfficacy: number): number => {
  const config = attacker.config ?? defender.config;
  if (!config) return Math.max(0, baseEfficacy);

  const effConfig = config.liquidation.karmaEfficacy;

  let shift = effConfig.base; // neutral shift
  if (defender.traits && attacker.traits) {
    // NOTE: reversed direction from threshold efficacy — defender's hand vs attacker's body
    const defAffinity = defender.traits.hand.affinity;
    const atkAffinity = attacker.traits.body.affinity;

    if (defAffinity === 'EERIE') {
      if (atkAffinity === 'SCRAP') shift = effConfig.up;
      else if (atkAffinity === 'INSECT') shift = effConfig.down;
    } else if (defAffinity === 'SCRAP') {
      if (atkAffinity === 'INSECT') shift = effConfig.up;
      else if (atkAffinity === 'EERIE') shift = effConfig.down;
    } else if (defAffinity === 'INSECT') {
      if (atkAffinity === 'EERIE') shift = effConfig.up;
      else if (atkAffinity === 'SCRAP') shift = effConfig.down;
    } else if (defAffinity === 'NORMAL') {
      if (atkAffinity === 'NORMAL') shift = effConfig.special;
    }
  }

  // no bonuses applied here yet (hardcoded zeroes in contract), floor at 0
  return Math.max(0, baseEfficacy + shift);
};

// calculate total liquidation hp recoil (PR #2384)
// old formula: (strain * ratio + karma) * boost — additive karma, single boost
// new formula: (karma + recoilEfficacy) * strain * boost — multiplicative, dual-sided boost
// boost now includes both DEF_RECOIL_BOOST (defender, increases recoil) and
// ATK_RECOIL_BOOST (attacker, reduces recoil). higher boost = more recoil on the attacker.
export const calcRecoil = (attacker: Kami, defender: Kami): number => {
  const baseConfig = attacker.config ?? defender.config;
  if (!baseConfig || !baseConfig.liquidation.recoil) return 0;

  const config = baseConfig.liquidation.recoil;

  // kami-lens (1.1.0): LibKill.calcRecoil in the chain's integers —
  // ((karma + efficacy) · strain · boost) / 10^(c1 + c3 + c7)
  const karma = BigInt(toRaw(calcKarma(attacker, defender), KARMA_PREC));
  const baseEfficacy = config.nudge.value; // config[0]/10^config[1] — base efficacy value
  const nudge = BigInt(toRaw(calcRecoilEfficacy(attacker, defender, baseEfficacy), config.nudge.precision));
  const strain = BigInt(Math.trunc(calcStrain(attacker, defender)));

  // boost: config base + defender's DEF_RECOIL_BOOST + attacker's ATK_RECOIL_BOOST
  const atkBoostBonus = toRaw(attacker.bonuses?.attack.recoil?.boost, 3);
  const defBoostBonus = toRaw(defender.bonuses?.defense.recoil?.boost, 3);
  const boostRaw = config.boost.raw + defBoostBonus + atkBoostBonus;
  const boost = BigInt(Math.max(0, boostRaw)); // clamp to 0 (can't have negative recoil)

  const precision = 10n ** BigInt(config.nudge.precision + config.ratio.precision + config.boost.precision);
  return Number(((karma + nudge) * strain * boost) / precision);
};

// determine whether a kami can liquidate another kami based on all requirements
export const canLiquidate = (attacker: Kami, defender: Kami): boolean => {
  return !onCooldown(attacker) && !isStarving(attacker) && canMog(attacker, defender);
};

// check whether a kami can liquidate another kami based on stat requirements
export const canMog = (attacker: Kami, defender: Kami): boolean => {
  return calcHealth(defender) < calcThreshold(attacker, defender);
};
