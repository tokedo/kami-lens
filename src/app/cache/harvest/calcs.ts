/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/app/cache/harvest/calcs.ts
 * changes:  Date.now() → clock.now() at 4 call sites plus the
 *           clock import (§3.8: offset-corrected stream clock, not naive
 *           wall clock — see src/clock.ts).
 *           1.1.0 (§3.19) — the harvest arithmetic is the chain's integers
 *           (LibHarvest, RATE_PREC = 6), not floats floored at 1e-6:
 *           calcFertility = LibHarvest.calcFertility, `(10^(6−(c3+c7)) ·
 *           power · c2 · efficacy) / 3600`, with the efficacy of
 *           LibHarvest.calcEfficacy — floored at 0 (`(efficacy < 0) ? 0`),
 *           and a NORMAL trait's `bonusShifts.up / 2` truncated toward zero
 *           (calcEfficacyShifts); calcIntensity = LibHarvest.calcIntensity,
 *           `(10^(6−c7+c3) · (c0·violence + ⌊Δreset/60⌋) · boost) /
 *           (c2 · 3600)` (`spot` keeps the client's extrapolation, on those
 *           integers); calcRawNetBounty = LibHarvest.calcBounty's
 *           `(rate · duration · boost) / 10^(6+c3+c7)`. The float versions
 *           read one unit (1e-6/s) low at exact values and kept the half of
 *           an odd NORMAL bonus. Bonuses are read back to their raw values at
 *           the precision getBonuses divides by. calcNetBounty / calcBounty
 *           (display) are unchanged; the float calcIntensityAt is removed
 *           (intensityUnits replaces it). Body otherwise verbatim.
 */

import * as clock from 'clock';
import { Harvest, RateDetails } from 'network/shapes/Harvest/types';
import type { AsphoAST } from 'network/shapes/Kami';
import { Kami } from 'network/shapes/Kami';
import { Efficacy } from 'network/shapes/Kami/configs';
import { getKamiBodyAffinity, getKamiHandAffinity } from '../kami';

/////////////////
// DURATION CALCS

// calculate the duration since a harvest has been collected from
export const calcIdleTime = (harvest: Harvest): number => {
  if (!harvest.time.last) return 0;
  const secondsSinceLast = clock.now() / 1000 - harvest.time.last;
  return Math.floor(secondsSinceLast); // intensity period
};

// get the number of seconds passed since the last harvest reset
export const calcIntensityTime = (harvest: Harvest): number => {
  if (!harvest.time.reset) return 0;
  const secondsSinceReset = clock.now() / 1000 - harvest.time.reset;
  return Math.floor(secondsSinceReset); // intensity period
};

// calculate the duration since a harvest was started
export const calcLifeTime = (harvest: Harvest): number => {
  return Math.floor(clock.now() / 1000 - harvest.time.start);
};

/////////////////
// OUTPUT CALCS

// Calculate the expected output from a harvest. Round down.
export const calcBounty = (harvest: Harvest): number => {
  const output = harvest.balance + calcNetBounty(harvest);
  return Math.max(0, output);
};

// Calculate the bounty since last sync.
// NOTE: rates must be calculated with updateRates first
export const calcNetBounty = (harvest: Harvest): number => {
  const duration = calcIdleTime(harvest);
  const rate = harvest.rates.total.average;
  return Math.floor(duration * rate);
};

// Calculate the bounty since last sync from first principles.
// Does not read from the rate cache, so it is safe to call even when
// rates have been zeroed for display (starve cutoff).
// Used by calcHealth and calcOutput, which need the real bounty to compute
// cap and strain correctly. See updateHarvestRate in kami/calcs/harvest.ts
// for why the rate cache gets zeroed and why these callers can't use it.
export const calcRawNetBounty = (harvest: Harvest, kami: Kami): number => {
  if (harvest.state !== 'ACTIVE' || !kami.config) return 0;
  // kami-lens (1.1.0): LibHarvest.calcBounty — (rate · duration · boost) /
  // 10^(RATE_PREC + c3 + c7), the rate in RATE_PREC units
  const config = kami.config.harvest.bounty;
  const boost = config.boost.raw + rawBonus(kami.bonuses?.harvest.bounty.boost, 3);
  const now = clock.now() / 1000;
  const rate = fertilityUnits(harvest, kami) + intensityUnits(kami, now - (harvest.time?.reset ?? now));
  const duration = calcIdleTime(harvest);
  const precision = 10n ** BigInt(RATE_PREC + config.ratio.precision + config.boost.precision);
  return Number((BigInt(rate) * BigInt(duration) * BigInt(boost)) / precision);
};

/////////////////
// kami-lens (1.1.0): THE CHAIN'S INTEGERS

/** LibHarvest's rate precision: rates are integers in 1e-6 MUSU per second */
const RATE_PREC = 6;

/** a bonus as getBonuses serves it (raw / 10^precision), back to its raw value */
const rawBonus = (scaled: number | undefined, precision: number): number =>
  Math.round((scaled ?? 0) * 10 ** precision);

/** 10^e as a BigInt; a negative exponent is a chain revert (uint underflow) */
const pow10 = (e: number): bigint => {
  if (e < 0) throw new Error(`negative precision exponent ${e}`);
  return 10n ** BigInt(e);
};

/** LibHarvest.calcEfficacy(comps, id, base, kamiID): the fertility boost slot
 * plus both trait shifts, in the boost's raw units, floored at 0 */
const efficacyRaw = (harvest: Harvest, kami: Kami, config: AsphoAST): number => {
  const shift = Math.round(calcEfficacyShifts(harvest, kami) * 10 ** config.boost.precision);
  return Math.max(0, config.boost.raw + shift);
};

/** LibHarvest.calcFertility, in RATE_PREC units */
const fertilityUnits = (harvest: Harvest, kami: Kami): number => {
  if (!kami.config) return 0;
  const config = kami.config.harvest.fertility;
  const power = Math.trunc(kami.stats?.power.total ?? 0);
  const precision = pow10(RATE_PREC - (config.ratio.precision + config.boost.precision));
  const efficacy = efficacyRaw(harvest, kami, config);
  return Number((precision * BigInt(power) * BigInt(config.ratio.raw) * BigInt(efficacy)) / 3600n);
};

/** LibHarvest.calcIntensity at `delta` seconds past the harvest's reset, in
 * RATE_PREC units — the nudge slot's RAW value times violence (the chain
 * reads config[0] without its precision slot), plus whole minutes */
const intensityUnits = (kami: Kami, delta: number): number => {
  if (!kami.config) return 0;
  const config = kami.config.harvest.intensity;
  const violence = Math.trunc(kami.stats?.violence.total ?? 0);
  const base = config.nudge.raw * violence;
  const nudge = Math.floor(delta / 60);
  const boost = config.boost.raw + rawBonus(kami.bonuses?.harvest.intensity.boost, 0);
  const precision = pow10(RATE_PREC - config.boost.precision + config.ratio.precision);
  return Number((precision * BigInt(base + nudge) * BigInt(boost)) / (BigInt(config.ratio.raw) * 3600n));
};

/////////////////
// RATE CALCS

// update the rate of an input harvest according to current conditions
// return the average total rate
export const updateRates = (harvest: Harvest, kami: Kami) => {
  if (harvest.state !== 'ACTIVE') return 0;
  if (!kami.config) return 0;
  const config = kami.config?.harvest.bounty;
  const boostBonus = kami.bonuses?.harvest.bounty.boost ?? 0;
  const boost = config.boost.value + boostBonus;

  const fertility = calcFertility(harvest, kami);
  const intensity = calcIntensity(harvest, kami);

  harvest.rates = {
    fertility,
    intensity,
    total: {
      average: boost * (fertility + intensity.average),
      spot: boost * (fertility + intensity.spot),
    },
  };
  return harvest.rates.total.average;
};

// calculate the fertility rate of harvest (per hour)
export const calcFertility = (harvest: Harvest, kami: Kami): number => {
  if (!kami.config) return 0;
  // kami-lens (1.1.0): the chain's integer rate (fertilityUnits), not a float
  return fertilityUnits(harvest, kami) / 10 ** RATE_PREC;
};

// calculate the intensity rates of a harvest, measured in musu/s
export const calcIntensity = (harvest: Harvest, kami: Kami): RateDetails => {
  const now = clock.now() / 1000;
  const lastTs = harvest.time?.last ?? now;
  const resetTs = harvest.time?.reset ?? now;

  // kami-lens (1.1.0): the chain's integer rates (intensityUnits)
  const initial = intensityUnits(kami, lastTs - resetTs);
  const current = intensityUnits(kami, now - resetTs);
  const spot = initial + 2 * (current - initial);

  return {
    average: current / 10 ** RATE_PREC,
    spot: spot / 10 ** RATE_PREC,
  };
};

// kami-lens (1.1.0): the client's float calcIntensityAt is replaced by
// intensityUnits (below calcRawNetBounty), the chain's integer form.

/////////////////
// EFFICACY

enum Effectiveness {
  NEUTRAL,
  UP,
  DOWN,
  SPECIAL,
}

// calculate the shift in harvest Efficacy (Fertility Boost)
export const calcEfficacyShifts = (harvest: Harvest, kami: Kami): number => {
  const node = harvest.node;
  if (!node || !kami.traits || !node.affinity) return 0;
  if (!kami.config) return 0;

  const bodyAff = getKamiBodyAffinity(kami);
  const handAff = getKamiHandAffinity(kami);

  const nodeAffs = node.affinity;
  if (nodeAffs.length > 2) {
    console.warn('invalid number of node affinities found', nodeAffs);
    return 0;
  }

  // determine most favorable matchup order
  // NOTE: below logic assumes no XX-NORMAL nodes and impact body > impact hand
  let nodeBodyAff = '';
  let nodeHandAff = '';
  if (nodeAffs.length == 1) {
    nodeBodyAff = nodeAffs[0];
    nodeHandAff = nodeAffs[0];
  } else if (nodeAffs.length == 2) {
    let isReversed = false;
    if (bodyAff === nodeAffs[1]) isReversed = true;
    else if (bodyAff !== nodeAffs[0] && handAff === nodeAffs[0]) isReversed = true;
    nodeBodyAff = isReversed ? nodeAffs[1] : nodeAffs[0];
    nodeHandAff = isReversed ? nodeAffs[0] : nodeAffs[1];
  }

  // calculate the efficacy shifts
  let shift = 0;
  const config = kami.config.harvest.efficacy;
  const upShiftBonus = kami.bonuses?.harvest.fertility.boost ?? 0;

  // kami-lens (1.1.0): LibHarvest.calcEfficacy's `bonusShifts.up / 2` is an
  // int256 division — it truncates toward zero; the client kept the half
  const normalShift = Math.trunc(rawBonus(upShiftBonus, 3) / 2) / 1e3;
  if (bodyAff === 'NORMAL') shift += normalShift;
  else {
    const effectiveness = getHarvestEffectiveness(nodeBodyAff, bodyAff);
    shift += calcEfficacyShift(effectiveness, config.body, upShiftBonus);
  }

  if (handAff === 'NORMAL') shift += normalShift;
  else {
    const effectiveness = getHarvestEffectiveness(nodeHandAff, handAff);
    shift += calcEfficacyShift(effectiveness, config.hand, upShiftBonus);
  }

  return shift;
};

// calculate the shift in Harvest Efficacy resulting from a trait matchup
export const calcEfficacyShift = (
  eff: Effectiveness,
  config: Efficacy,
  upShiftBonus: number
): number => {
  if (eff === Effectiveness.UP) return config.up + upShiftBonus;
  if (eff === Effectiveness.NEUTRAL) return config.base;
  if (eff === Effectiveness.DOWN) return config.down;
  return config.special;
};

// determine how effective a trait matchup is for a harvest
export const getHarvestEffectiveness = (nodeAff: string, traitAff: string): Effectiveness => {
  if (nodeAff === 'NORMAL' || traitAff === 'NORMAL') return Effectiveness.NEUTRAL;
  if (nodeAff === traitAff) return Effectiveness.UP;
  return Effectiveness.DOWN;
};
