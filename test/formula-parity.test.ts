// 1.1.0 (§3.19): the contract-formula parity test.
//
// For every contract formula of the studio's domain manifest, the lens's
// ported counterpart is evaluated beside a reference evaluation of the
// Solidity arithmetic — transcribed here with its integer precision slots,
// truncating division and clamps — at hand-picked inputs that exercise the
// rounding boundaries, and over seeded sweeps of realistic inputs. Where the
// port and the chain disagree, the test asserts the DOCUMENTED divergence
// (its class and its size), never a tolerance that would hide it; the list is
// docs/measurements/formula-parity-2026-10-23.md. Formulas with no port are
// listed as unported. 1.1.0 item 7 resolved every divergence in a SERVED
// value: those assertions now require agreement (they fail on the ports as
// 1.1.0 found them), and the sweeps require zero divergent samples. The few
// divergences left documented are not served (a display rate, an unset-
// timestamp guard, a display-only tax helper) — each says so.
//
// SOURCES. The formula list (`generated/formulas.yaml`: 40 keys, the two
// LibHarvest.calcEfficacy overloads among them) and the Solidity bodies it
// quotes are from the Kami Atlas by Asphodel Studios,
// https://github.com/Asphodel-OS/kami-atlas (commit ac64364), generated from
// kamigotchi at 04cb25f8f300 — licensed CC BY 4.0. The transcriptions below,
// and the math primitives in test/support/solidity.ts, are this repository's
// own code (AGPL-3.0-only), written against the contract source at
// Asphodel-OS/kamigotchi-open @ 04cb25f8 (AGPL-3.0-only), which is the
// authority wherever the two differ. Config arrays are the live world's
// (test/support/mirror.ts LIVE_KAMI_CONFIG, read 2026-10-03).
//
// The port side runs exactly the code the daemon runs, on the shapes it
// builds: configs through network/shapes/Kami/configs.getConfigs on a
// synthetic mirror, bonuses at the precisions network/shapes/Kami/bonuses.ts
// divides by (3, or 0 for HARV_INTENSITY_BOOST), and the clock pinned.

import { writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as clock from 'clock';
import { setComponent } from 'engine/recs';
import { hashArgs } from 'network/shapes/utils';
import { getConfigs } from 'network/shapes/Kami/configs';
import type { Kami } from 'network/shapes/Kami';
import type { Bonuses } from 'network/shapes/Kami/bonuses';
import { getStatFromUint } from 'network/shapes/Stats';
import { calcExperienceRequirement } from 'network/shapes/Kami/progress';
import { calcAmountOut } from 'network/shapes/Pool/pricing';
import { getValue as getBonusValue } from 'network/shapes/Bonus/types';
import { getDTDetails } from 'network/shapes/Droptable';
import { calcCurrentStamina, sync as statSync } from 'app/cache/account/calcs';
import { clearConfigCaches } from 'app/cache/config/base';
import { getConfig as getPortalConfig } from 'app/cache/config/portal';
import {
  calcEfficacyShift,
  calcEfficacyShifts,
  calcFertility,
  calcIdleTime as calcHarvestIdleTime,
  calcIntensity,
  calcIntensityTime,
} from 'app/cache/harvest/calcs';
import { calcHealth, calcHealthRate } from 'app/cache/kami/calcs/base';
import { calcMaxMusu, calcOutput, calcStrainFromBalance } from 'app/cache/kami/calcs/harvest';
import {
  calcKarma,
  calcRecoil,
  calcRecoilEfficacy,
  calcSalvage,
  calcSpoils,
  calcStrain as calcLiqStrain,
  calcThreshold,
} from 'app/cache/kami/calcs/liquidation';
import { calcBuyPrice, calcSellPrice } from 'app/cache/npc/calcs';
import { calcTax as calcTradeTax } from 'app/cache/trade/functions';
import { calcPrice as calcAuctionPrice } from 'network/explorer/auctions/pricing';
import { auctionPriceOut } from '../src/queries/feeds';
import { LIVE_KAMI_CONFIG, makeMirror, packArray32 } from './support/mirror';
import { WAD, cdf, expWad, gdaCalc, lnWad, powWad, sdExp2, sdLog2, usub } from './support/solidity';

const NOW = 1_790_000_000; // the pinned chain second every case is evaluated at

// ======================================================= the mapping table

type Mapping = {
  formula: string;
  /** the ported counterpart; null = unported */
  port: string | null;
  /** where its value reaches an answer; null = not served (display helper) */
  served: string | null;
  /** compared directly, or through the named composite */
  how: string;
  why?: string;
};

const MAP: Mapping[] = [
  { formula: 'LibAccount.calcStaminaRecovery', port: 'app/cache/account/calcs.calcCurrentStamina', served: 'account stamina.current', how: 'direct' },
  { formula: 'LibAffinity.calcEfficacyShift', port: 'app/cache/harvest/calcs.calcEfficacyShift', served: 'via fertility → musu accrued', how: 'direct' },
  { formula: 'LibAuction.calcBuy', port: 'network/explorer/auctions/pricing.calcPrice (app/cache/auction/functions.calcPrice is the same copy)', served: 'auctions price', how: 'direct' },
  { formula: 'LibBonus.calcSingle', port: 'network/shapes/Bonus/types.getValue', served: 'every bonus-dependent value', how: 'direct' },
  { formula: 'LibExperience.calcLevelCost', port: 'network/shapes/Kami/progress.calcExperienceRequirement', served: 'kami / party / node xpRequired', how: 'direct' },
  { formula: 'LibGDA.calc', port: 'inlined in app/cache/npc/calcs.calcBuyPriceGDA and the auctions calcPrice', served: 'merchant buyPrice, auctions price', how: 'through LibListing.calcBuyPrice and LibAuction.calcBuy' },
  { formula: 'LibHarvest.calcBounty', port: 'app/cache/kami/calcs/harvest.calcOutput (calcRawNetBounty capped by calcMaxMusu)', served: 'kami musu.accrued, node vitals.musuAccrued', how: 'direct' },
  { formula: 'LibHarvest.calcDuration', port: 'app/cache/harvest/calcs.calcIdleTime', served: 'via the bounty', how: 'direct' },
  { formula: 'LibHarvest.calcEfficacy(string,string,Shifts,string)', port: 'app/cache/harvest/calcs.calcEfficacyShifts (one trait)', served: 'via fertility → musu accrued', how: 'direct' },
  { formula: 'LibHarvest.calcEfficacy(uint256,uint256,uint256)', port: 'app/cache/harvest/calcs.calcEfficacyShifts + the fertility boost', served: 'via fertility → musu accrued', how: 'direct' },
  { formula: 'LibHarvest.calcFertility', port: 'app/cache/harvest/calcs.calcFertility', served: 'via the bounty; kami musu rates', how: 'direct' },
  { formula: 'LibHarvest.calcIntensity', port: 'app/cache/harvest/calcs.calcIntensity (.average)', served: 'via the bounty; kami musu rates', how: 'direct' },
  { formula: 'LibHarvest.calcIntensityDuration', port: 'app/cache/harvest/calcs.calcIntensityTime', served: 'via intensity', how: 'direct' },
  { formula: 'LibHarvest.calcMaxMusu', port: 'app/cache/kami/calcs/harvest.calcMaxMusu', served: 'via the bounty cap', how: 'direct' },
  { formula: 'LibKami.calcMetabolism', port: 'app/cache/kami/calcs/base.calcHealthRate (RESTING)', served: 'kami hpRatePerHr (a display string)', how: 'direct' },
  { formula: 'LibKami.calcRecovery', port: 'app/cache/kami/calcs/base.calcHealth (RESTING)', served: 'kami / party / node hp.current', how: 'direct' },
  { formula: 'LibKami.calcStrain', port: 'app/cache/kami/calcs/harvest.calcStrainFromBalance (round up)', served: 'hp.current of a harvesting kami; the recoil strain', how: 'direct' },
  { formula: 'LibKamiMarket.calcFee', port: null, served: null, how: 'unported', why: 'the lens serves no kami-market fee' },
  { formula: 'LibKill.calcAnimosity', port: 'app/cache/kami/calcs/liquidation.calcAnimosity (module-private)', served: 'node liquidation.threshold', how: 'through LibKill.calcThreshold' },
  { formula: 'LibKill.calcKarma', port: 'app/cache/kami/calcs/liquidation.calcKarma', served: 'via node liquidation.recoil', how: 'direct' },
  { formula: 'LibKill.calcRecoil', port: 'app/cache/kami/calcs/liquidation.calcRecoil', served: 'node liquidation.recoil', how: 'direct' },
  { formula: 'LibKill.calcRecoilEfficacy', port: 'app/cache/kami/calcs/liquidation.calcRecoilEfficacy', served: 'via node liquidation.recoil', how: 'direct' },
  { formula: 'LibKill.calcSalvage', port: 'app/cache/kami/calcs/liquidation.calcSalvage', served: 'node liquidation.salvage', how: 'direct' },
  { formula: 'LibKill.calcSpoils', port: 'app/cache/kami/calcs/liquidation.calcSpoils', served: 'node liquidation.spoils', how: 'direct' },
  { formula: 'LibKill.calcThreshold', port: 'app/cache/kami/calcs/liquidation.calcThreshold', served: 'node liquidation.threshold, margin, eligible', how: 'direct' },
  { formula: 'LibKill.calcThresholdEfficacy', port: 'app/cache/kami/calcs/liquidation.calcEfficacy (module-private)', served: 'node liquidation.threshold', how: 'through LibKill.calcThreshold' },
  { formula: 'LibKill.calculateHealthValues', port: null, served: null, how: 'unported', why: 'a (sync, total) pair; the client reads both off the Stats shape' },
  { formula: 'LibListing.calcBuyPrice', port: 'app/cache/npc/calcs.calcBuyPrice', served: 'merchant buyPrice', how: 'direct' },
  { formula: 'LibListing.calcSellPrice', port: 'app/cache/npc/calcs.calcSellPrice', served: 'merchant sellPrice', how: 'direct' },
  { formula: 'LibPool.calcAmountOut', port: 'network/shapes/Pool/pricing.calcAmountOut', served: 'quote amountOut', how: 'direct' },
  { formula: 'LibPool.calcInitialLiquidity', port: null, served: null, how: 'unported', why: 'pool creation (admin); the lens serves no LP share' },
  { formula: 'LibRandom.calcRarityWeight', port: 'inlined in network/shapes/Droptable.getDTDetails', served: 'droptable odds text (enrich)', how: 'direct' },
  { formula: 'LibStat.calcSync', port: 'app/cache/account/calcs.sync', served: 'account stamina.current', how: 'direct' },
  { formula: 'LibStat.calcTotal', port: 'network/shapes/Stats.getStatFromUint (.total)', served: 'hp.total, stats.*.total', how: 'direct' },
  { formula: 'LibTax.calcBill', port: null, served: null, how: 'unported', why: 'the harvest tax split; the lens serves no tax' },
  { formula: 'LibTokenPortal.calcExportTax', port: null, served: null, how: 'unported', why: 'the portal tax config is ported (app/cache/config/portal), its arithmetic is not' },
  { formula: 'LibTokenPortal.calcImportTax', port: null, served: null, how: 'unported', why: 'as calcExportTax' },
  { formula: 'LibTokenPortal.calcWithdrawalDelay', port: 'app/cache/config/portal.getConfig (.delay)', served: null, how: 'direct' },
  { formula: 'LibTrade.calcTax', port: 'app/cache/trade/functions.calcTax', served: null, how: 'direct' },
  { formula: 'NewbieVendorBuySystem.calcPrice', port: null, served: null, how: 'unported', why: 'the lens serves the vendor display window, not its price (a cheapest-listing scan)' },
];

// ================================================================ records

type Result = { formula: string; case: string; chain: string; port: string; class: string };
const RESULTS: Result[] = [];
type Sweep = { formula: string; samples: number; divergent: number; diffs: Record<string, number>; class: string; examples: string[] };
const SWEEPS: Sweep[] = [];

/** One hand-picked case. Without `div` the port must equal the chain to the
 * unit; with it, the port must equal what the documented divergence says. */
function pair(
  formula: string,
  label: string,
  chain: bigint | string,
  port: number | string,
  div?: { cls: string; port: number | string }
) {
  RESULTS.push({ formula, case: label, chain: String(chain), port: String(port), class: div?.cls ?? 'equal' });
  expect(String(port)).toBe(String(div ? div.port : chain));
}

/** A seeded sweep: every port − chain difference must be in `allowed`, and
 * the number of divergent samples must be the documented one. */
function sweep(
  formula: string,
  cls: string,
  n: number,
  gen: (rnd: (lo: number, hi: number) => number) => { chain: bigint; port: number; label: string } | null,
  allowed: number[],
  documentedDivergent: number,
  seed = 20261023
) {
  let s = seed;
  const rnd = (lo: number, hi: number) => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return lo + (s % (hi - lo + 1));
  };
  const diffs: Record<string, number> = {};
  const examples: string[] = [];
  let samples = 0;
  let divergent = 0;
  for (let i = 0; i < n; i++) {
    const c = gen(rnd);
    if (!c) continue;
    samples++;
    const d = c.port - Number(c.chain);
    diffs[String(d)] = (diffs[String(d)] ?? 0) + 1;
    if (d !== 0) {
      divergent++;
      if (examples.length < 3) examples.push(`${c.label}: chain ${c.chain}, port ${c.port}`);
    }
  }
  SWEEPS.push({ formula, samples, divergent, diffs, class: cls, examples });
  for (const d of Object.keys(diffs)) expect(allowed, `${formula}: difference ${d}`).toContain(Number(d));
  expect(divergent, `${formula}: divergent samples of ${samples}`).toBe(documentedDivergent);
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
  clock.reset();
});
afterAll(() => {
  vi.useRealTimers();
  clock.reset();
  // FORMULA_PARITY_RECORD=<path> writes the table the measurement record is
  // rendered from
  const out = process.env.FORMULA_PARITY_RECORD;
  if (out) writeFileSync(out, JSON.stringify({ now: NOW, map: MAP, results: RESULTS, sweeps: SWEEPS }, null, 1) + '\n');
});

// ============================================================ port inputs

const B = (n: number | bigint) => BigInt(n);
const cfg = (k: string) => LIVE_KAMI_CONFIG[k]!.map(B);
const LIVE = (() => {
  const m = makeMirror(1);
  return getConfigs(m.world, m.components);
})();

type BonusIn = Partial<{
  atkThresholdRatio: number;
  atkThresholdShift: number;
  atkSpoilsRatio: number;
  atkRecoilBoost: number;
  defThresholdRatio: number;
  defThresholdShift: number;
  defSalvageRatio: number;
  defRecoilBoost: number;
  harvFertilityBoost: number;
  harvIntensityBoost: number;
  harvBountyBoost: number;
  strainBoost: number;
  metabolismBoost: number;
}>;

/** bonuses given as RAW chain values, scaled the way getBonuses scales them */
function bonuses(b: BonusIn = {}): Bonuses {
  const k = (raw: number | undefined, prec = 3) => (raw ?? 0) / 10 ** prec;
  const z = { nudge: 0, ratio: 0, shift: 0, boost: 0 };
  return {
    attack: {
      threshold: { ...z, ratio: k(b.atkThresholdRatio), shift: k(b.atkThresholdShift) },
      spoils: { ...z, ratio: k(b.atkSpoilsRatio) },
      recoil: { ...z, boost: k(b.atkRecoilBoost) },
    },
    defense: {
      threshold: { ...z, ratio: k(b.defThresholdRatio), shift: k(b.defThresholdShift) },
      salvage: { ...z, ratio: k(b.defSalvageRatio) },
      recoil: { ...z, boost: k(b.defRecoilBoost) },
    },
    harvest: {
      fertility: { ...z, boost: k(b.harvFertilityBoost) },
      intensity: { ...z, boost: k(b.harvIntensityBoost, 0) },
      bounty: { ...z, boost: k(b.harvBountyBoost) },
      strain: { ...z, boost: k(b.strainBoost) },
    },
    rest: { metabolism: { ...z, boost: k(b.metabolismBoost) } },
    general: { cooldown: 0 },
  } as unknown as Bonuses;
}

type KamiIn = {
  state?: string;
  power?: number;
  harmony?: number;
  violence?: number;
  hpTotal?: number;
  hpSync?: number;
  body?: string;
  hand?: string;
  bonus?: BonusIn;
  /** times in seconds before NOW */
  harvest?: { balance?: number; last: number; reset: number; nodeAff: string[] };
  /** seconds before NOW */
  idle?: number;
};

function kami(s: KamiIn): Kami {
  const stat = (total: number, sync = total) => ({ base: total, shift: 0, boost: 0, sync, rate: 0, total });
  return {
    ObjectType: 'KAMI',
    id: '0x1',
    index: 1,
    name: 'k',
    image: '',
    state: s.state ?? (s.harvest ? 'HARVESTING' : 'RESTING'),
    config: LIVE,
    bonuses: bonuses(s.bonus),
    stats: {
      health: stat(s.hpTotal ?? 200, s.hpSync ?? s.hpTotal ?? 200),
      power: stat(s.power ?? 20),
      harmony: stat(s.harmony ?? 20),
      violence: stat(s.violence ?? 20),
      slots: stat(0),
    },
    traits: { body: { affinity: s.body ?? 'NORMAL' }, hand: { affinity: s.hand ?? 'NORMAL' } },
    harvest: s.harvest
      ? {
          state: 'ACTIVE',
          balance: s.harvest.balance ?? 0,
          time: { last: NOW - s.harvest.last, reset: NOW - s.harvest.reset, start: NOW - s.harvest.reset },
          node: { affinity: s.harvest.nodeAff },
          rates: { total: { average: 0, spot: 0 } },
        }
      : undefined,
    time: { last: NOW - (s.idle ?? 3600), cooldown: 0, start: 0 },
  } as unknown as Kami;
}

/** a port value at the chain's precision, asserting it sits on that grid */
function units(x: number, prec: number): number {
  const scaled = x * 10 ** prec;
  const n = Math.round(scaled);
  expect(Math.abs(scaled - n), `off the 1e-${prec} grid: ${x}`).toBeLessThan(1e-6);
  return n;
}

// ========================================================== the reference
// Transcriptions of the contract bodies (Asphodel-OS/kamigotchi-open @
// 04cb25f8, packages/contracts/src/libraries/…). BigInt division truncates
// toward zero, as Solidity's does.

type Shifts = { base: bigint; up: bigint; down: bigint; special: bigint };
type Effectiveness = 'Strong' | 'Neutral' | 'Weak' | 'Special';
const ZERO: Shifts = { base: 0n, up: 0n, down: 0n, special: 0n };

/** LibAffinity.getShifts — the config's precision slot [0] is NOT read */
const getShifts = (c: bigint[]): Shifts => ({ base: c[1]!, up: c[2]!, down: -c[3]!, special: c[4]! });

/** LibAffinity.calcEfficacyShift */
const refEfficacyShift = (e: Effectiveness, c: Shifts, b: Shifts) =>
  e === 'Strong' ? c.up + b.up : e === 'Weak' ? c.down + b.down : e === 'Special' ? c.special + b.special : c.base + b.base;

/** LibAffinity.getHarvestEffectiveness */
const harvestEffectiveness = (s: string, t: string): Effectiveness =>
  s === '' || t === '' || s === 'NORMAL' || t === 'NORMAL' ? 'Neutral' : s === t ? 'Strong' : 'Weak';

/** LibAffinity.getAttackEffectiveness */
function attackEffectiveness(s: string, t: string): Effectiveness {
  if (s === 'NORMAL' && t === 'NORMAL') return 'Special';
  const beats: Record<string, [string, string]> = {
    EERIE: ['SCRAP', 'INSECT'],
    SCRAP: ['INSECT', 'EERIE'],
    INSECT: ['EERIE', 'SCRAP'],
  };
  const b = beats[s];
  if (b && t === b[0]) return 'Strong';
  if (b && t === b[1]) return 'Weak';
  return 'Neutral';
}

/** LibHarvest.calcEfficacy(comps, traitAff, nodeAff, bonusShifts, configKey) */
function refTraitEfficacy(trait: string, node: string, bonusUp: bigint, key: string) {
  if (trait === 'NORMAL') return bonusUp / 2n; // int256 division: toward zero
  return refEfficacyShift(harvestEffectiveness(trait, node), getShifts(cfg(key)), { ...ZERO, up: bonusUp });
}

/** LibHarvest.calcEfficacy(comps, id, base, kamiID) */
function refHarvestEfficacy(base: bigint, body: string, hand: string, nodeAff: string, bonusUp: bigint) {
  const affs = nodeAff.split('-');
  if (affs.length > 2) throw new Error('too many node affinities');
  let nb = nodeAff;
  let nh = nodeAff;
  if (affs.length === 2) {
    let rev = false;
    if (body === affs[1]) rev = true;
    else if (body !== affs[0] && hand === affs[0]) rev = true;
    nb = rev ? affs[1]! : affs[0]!;
    nh = rev ? affs[0]! : affs[1]!;
  }
  let e = base;
  e += refTraitEfficacy(body, nb, bonusUp, 'KAMI_HARV_EFFICACY_BODY');
  e += refTraitEfficacy(hand, nh, bonusUp, 'KAMI_HARV_EFFICACY_HAND');
  return e < 0n ? 0n : e;
}

const RATE_PREC = 6n;
const METABOLISM_PREC = 9n;
const ANIMOSITY_PREC = 6n;
const KARMA_PREC = 3n;

/** LibHarvest.calcFertility (RATE_PREC) */
function refFertility(power: bigint, efficacy: bigint) {
  const c = cfg('KAMI_HARV_FERTILITY');
  const precision = 10n ** (RATE_PREC - (c[3]! + c[7]!));
  return (precision * power * c[2]! * efficacy) / 3600n;
}

/** LibHarvest.calcIntensity (RATE_PREC); secondsSinceReset = calcIntensityDuration */
function refIntensity(violence: bigint, secondsSinceReset: bigint, bonus = 0n) {
  const c = cfg('KAMI_HARV_INTENSITY');
  const base = c[0]! * violence;
  const nudge = secondsSinceReset / 60n;
  const boost = c[6]! + bonus;
  const precision = 10n ** (RATE_PREC - c[7]! + c[3]!);
  return (precision * (base + nudge) * boost) / (c[2]! * 3600n);
}

/** LibHarvest.calcMaxMusu */
function refMaxMusu(hp: bigint, harmony: bigint, bonus = 0n) {
  if (hp <= 0n) return 0n;
  const c = cfg('KAMI_HARV_STRAIN');
  const boost = c[6]! + bonus;
  if (boost < 0n) throw new Error('SafeCast toUint256');
  const denom = c[2]! * boost;
  if (denom === 0n) return (1n << 256n) - 1n;
  const precision = 10n ** (c[3]! + c[7]!);
  return (hp * (precision * (harmony + c[0]!))) / denom;
}

/** LibHarvest.calcBounty: min((fertility + intensity) × duration × boost / prec, maxMusu) */
function refBounty(fertility: bigint, intensity: bigint, duration: bigint, maxMusu: bigint, bonus = 0n) {
  const c = cfg('KAMI_HARV_BOUNTY');
  const boost = c[6]! + bonus;
  const raw = ((fertility + intensity) * duration * boost) / 10n ** (RATE_PREC + c[3]! + c[7]!);
  return raw < maxMusu ? raw : maxMusu;
}

/** LibKami.calcStrain — rounds UP */
function refStrain(amt: bigint, harmony: bigint, bonus = 0n) {
  const c = cfg('KAMI_HARV_STRAIN');
  const boost = c[6]! + bonus;
  const precision = 10n ** (c[3]! + c[7]!);
  const divisor = precision * (harmony + c[0]!);
  return (amt * c[2]! * boost + (divisor - 1n)) / divisor;
}

/** LibKami.calcMetabolism (METABOLISM_PREC) */
function refMetabolism(harmony: bigint, bonus = 0n) {
  const c = cfg('KAMI_REST_METABOLISM');
  const boost = c[6]! + bonus;
  const precision = 10n ** (METABOLISM_PREC - (c[3]! + c[7]!));
  return (precision * (harmony + c[0]!) * c[2]! * boost) / 3600n;
}

/** LibStat.calcSync */
function refCalcSync(max: bigint, curr: bigint, delta: bigint) {
  const r = curr + delta;
  return r < 0n ? 0n : r > max ? max : r;
}

/** LibKami.calcRecovery, then LibStat.calcSync onto the stored hp */
function refRestingHealth(sync: bigint, total: bigint, harmony: bigint, idle: bigint, bonus = 0n) {
  const recovery = (idle * refMetabolism(harmony, bonus)) / 10n ** METABOLISM_PREC;
  return refCalcSync(total, sync, recovery);
}

/** LibKill.calcAnimosity: Gaussian.cdf(lnWad(1e18·v1/h2)) × ratio, ANIMOSITY_PREC */
function refAnimosity(v1: bigint, h2: bigint) {
  const c = cfg('KAMI_LIQ_ANIMOSITY');
  const base = cdf(lnWad((WAD * v1) / h2));
  return (base * c[2]!) / 10n ** (18n + c[3]! - ANIMOSITY_PREC);
}

/** LibKill.calcThreshold, with calcThresholdEfficacy inlined */
function refThreshold(
  aViolence: bigint,
  aHand: string,
  dHarmony: bigint,
  dBody: string,
  dHealthTotal: bigint,
  b: { atkRatio?: bigint; defRatio?: bigint; atkShift?: bigint; defShift?: bigint } = {}
) {
  const c = cfg('KAMI_LIQ_THRESHOLD');
  const base = refAnimosity(aViolence, dHarmony);
  const r = (b.atkRatio ?? 0n) - (b.defRatio ?? 0n);
  let ratio =
    c[2]! +
    refEfficacyShift(attackEffectiveness(aHand, dBody), getShifts(cfg('KAMI_LIQ_EFFICACY')), { base: 0n, up: r, down: 0n, special: r });
  if (ratio < 0n) ratio = 0n;
  const shiftPrec = 10n ** (ANIMOSITY_PREC + c[3]! - c[5]!);
  const shift = ((b.atkShift ?? 0n) - (b.defShift ?? 0n)) * shiftPrec;
  const post = base * ratio + shift;
  if (post < 0n) return 0n;
  return (post * dHealthTotal) / 10n ** (ANIMOSITY_PREC + c[3]! + c[7]!);
}

/** LibKill.calcKarma (defender violence vs attacker harmony), KARMA_PREC */
function refKarma(dViolence: bigint, aHarmony: bigint) {
  const c = cfg('KAMI_LIQ_KARMA');
  const base = cdf(lnWad((WAD * dViolence) / aHarmony));
  return (base * c[2]!) / 10n ** (18n + c[3]! - KARMA_PREC);
}

/** LibKill.calcRecoilEfficacy (defender HAND vs attacker BODY) */
function refRecoilEfficacy(dHand: string, aBody: string, base: bigint) {
  const e = base + refEfficacyShift(attackEffectiveness(dHand, aBody), getShifts(cfg('KAMI_LIQ_KARMA_EFFICACY')), ZERO);
  return e > 0n ? e : 0n;
}

/** LibKill.calcRecoil */
function refRecoil(dViolence: bigint, dHand: string, aHarmony: bigint, aBody: string, strain: bigint, atkBoost = 0n, defBoost = 0n) {
  const c = cfg('KAMI_LIQ_RECOIL');
  const base = refKarma(dViolence, aHarmony);
  const nudge = refRecoilEfficacy(dHand, aBody, c[0]!);
  const raw = c[6]! + defBoost + atkBoost;
  const boost = raw > 0n ? raw : 0n;
  return ((base + nudge) * strain * boost) / 10n ** (c[1]! + c[3]! + c[7]!);
}

/** LibKill.calcSalvage / calcSpoils (one body, two config keys) */
function refShare(key: 'KAMI_LIQ_SALVAGE' | 'KAMI_LIQ_SPOILS', power: bigint, amt: bigint, ratioBonus = 0n) {
  const c = cfg(key);
  if (ratioBonus < 0n) throw new Error('SafeCast toUint256');
  const powerTuning = (c[0]! + power) * 10n ** (c[3]! - c[1]!);
  const ratio = c[2]! + powerTuning + ratioBonus;
  const precision = 10n ** c[3]!;
  if (ratio / precision > 1n) return amt;
  return (amt * ratio) / precision;
}

/** HarvestLiquidateSystem: salvage, then the spoils of what remains (checked) */
function refLiquidationShares(victimPower: bigint, killerPower: bigint, bounty: bigint) {
  const salvage = refShare('KAMI_LIQ_SALVAGE', victimPower, bounty);
  const spoils = refShare('KAMI_LIQ_SPOILS', killerPower, usub(bounty, salvage));
  return { salvage, spoils };
}

/** LibExperience.calcLevelCost (Solady powWad) on the live config */
function refLevelCost(level: number, base = 40n, mult: [bigint, bigint] = [1259n, 3n]) {
  let multiplier = WAD;
  if (level > 1) multiplier = powWad((WAD * mult[0]) / 10n ** mult[1], B(level - 1) * WAD);
  return (base * multiplier) / WAD;
}

/** LibStat.calcTotal (int32: truncation toward zero, floored at 0) */
function refStatTotal(base: bigint, shift: bigint, boost: bigint) {
  const t = ((1000n + boost) * (base + shift)) / 1000n;
  return t > 0n ? t : 0n;
}

type GdaIn = { type: 'FIXED' | 'GDA'; value: number; period?: number; decay?: number; rate?: number; prevSold?: number; startTs?: number };

/** LibListing.calcBuyPrice */
function refListingBuy(p: GdaIn, amt: number) {
  if (amt === 0) return 0n;
  if (p.type === 'FIXED') return B(p.value) * B(amt);
  const params = {
    targetPrice: B(p.value),
    startTs: B(p.startTs!),
    period: B(p.period!),
    decay: B(p.decay!) * 10n ** 12n,
    rate: B(p.rate!),
    prevSold: B(p.prevSold!),
    quantity: B(amt),
  };
  if (B(amt) > params.rate * 100n) throw new Error('LibListing: batch too large');
  const cap = (params.prevSold * params.period) / params.rate + 3n * params.period;
  if (B(NOW) - params.startTs > cap) params.startTs = B(NOW) - cap;
  const cost = gdaCalc(params, B(NOW));
  if (cost <= 0n) throw new Error('LibListing: non-positive GDA cost');
  const price = (cost + WAD - 1n) / WAD;
  return price < B(amt) ? B(amt) : price;
}

type AuctionIn = { value: number; startTs: number; period: number; decay: number; rate: number; sold: number };

/** LibAuction.calcBuy */
function refAuctionBuy(p: AuctionIn, amt: number) {
  const cost = gdaCalc(
    { targetPrice: B(p.value), startTs: B(p.startTs), period: B(p.period), decay: B(p.decay) * 10n ** 12n, rate: B(p.rate), prevSold: B(p.sold), quantity: B(amt) },
    B(NOW)
  );
  if (cost <= 0n) throw new Error('LibAuction: negative GDA cost');
  return (cost + WAD - 1n) / WAD;
}

/** the client's Listing shape: decay as the component's 1e6 value (getDecay(…, 6)) */
const listingOf = (p: GdaIn, sell?: { type: string; scale?: number }) =>
  ({
    value: p.value,
    balance: p.prevSold ?? 0,
    startTime: p.startTs ?? 0,
    buy: p.type === 'FIXED' ? { type: 'FIXED' } : { type: 'GDA', period: p.period, decay: (p.decay ?? 0) / 1e6, rate: p.rate },
    ...(sell ? { sell } : {}),
  }) as never;
const auctionOf = (p: AuctionIn) =>
  ({
    auctionItem: { index: 1 },
    params: { value: p.value, period: p.period, decay: p.decay / 1e6, rate: p.rate },
    time: { start: p.startTs },
    supply: { sold: p.sold },
  }) as never;
const gda = (value: number, period: number, decay: number, rate: number, prevSold: number, since: number): GdaIn => ({
  type: 'GDA',
  value,
  period,
  decay,
  rate,
  prevSold,
  startTs: NOW - since,
});

const AFF = ['EERIE', 'SCRAP', 'INSECT'];
const AFF4 = ['EERIE', 'SCRAP', 'INSECT', 'NORMAL'];

// ================================================================ tests

describe('the mapping table', () => {
  it('names every formula of the manifest once: 33 compared (30 directly, 3 through a composite), 7 unported', () => {
    expect(MAP).toHaveLength(40);
    expect(new Set(MAP.map((m) => m.formula)).size).toBe(40);
    expect(MAP.filter((m) => m.how === 'unported').map((m) => m.formula)).toEqual([
      'LibKamiMarket.calcFee',
      'LibKill.calculateHealthValues',
      'LibPool.calcInitialLiquidity',
      'LibTax.calcBill',
      'LibTokenPortal.calcExportTax',
      'LibTokenPortal.calcImportTax',
      'NewbieVendorBuySystem.calcPrice',
    ]);
    expect(MAP.filter((m) => m.how === 'direct')).toHaveLength(30);
    expect(MAP.filter((m) => m.how.startsWith('through'))).toHaveLength(3);
  });
});

describe('the transcribed primitives reproduce their libraries', () => {
  it("Solady/Solmate expWad and lnWad: the libraries' own published test vectors", () => {
    const e = (x: bigint) => expWad(x).toString();
    expect(e(-3n * WAD)).toBe('49787068367863942');
    expect(e(-1n * WAD)).toBe('367879441171442321');
    expect(e(-5n * 10n ** 17n)).toBe('606530659712633423');
    expect(e(0n)).toBe('1000000000000000000');
    expect(e(WAD)).toBe('2718281828459045235');
    expect(e(3n * WAD)).toBe('20085536923187667741');
    expect(lnWad(WAD).toString()).toBe('0');
    expect(lnWad(2718281828459045235n).toString()).toBe('999999999999999999');
    expect(lnWad(11723640096265400935n).toString()).toBe('2461607324344817918');
  });

  it('PRBMath exp2 / log2: exact on powers of two', () => {
    expect(sdExp2(3n * WAD)).toBe(8n * WAD);
    expect(sdExp2(-2n * WAD)).toBe(WAD / 4n);
    expect(sdLog2(16n * WAD)).toBe(4n * WAD);
    expect(sdLog2(WAD / 8n)).toBe(-3n * WAD);
  });

  it('Gaussian.cdf: 1/2 at 0, and within its stated 1.2e-7 of the normal cdf at 1', () => {
    expect(cdf(0n)).toBe(WAD / 2n);
    expect(Math.abs(Number(cdf(WAD)) / 1e18 - 0.8413447460685429)).toBeLessThan(1.2e-7);
  });
});

describe('LibAccount.calcStaminaRecovery + LibStat.calcSync ↔ calcCurrentStamina, sync', () => {
  // ACCOUNT_STAMINA's recovery period, config[1]: 60 s here (the client's own
  // fallback when the config reads 0 — the chain would divide by zero)
  const recovery = 60;
  const port = (sync: number, total: number, sinceAction: number) =>
    calcCurrentStamina({ config: { stamina: { recovery } }, time: { action: NOW - sinceAction }, stamina: { sync, total } } as never);
  const chain = (sync: number, total: number, sinceAction: number) =>
    refCalcSync(B(total), B(sync), B(sinceAction) / B(recovery));

  it.each([
    ['an exact multiple of the period', 40, 100, 600],
    ['one second short of the next point', 40, 100, 659],
    ['clamped at the total', 95, 100, 3_600],
    ['from empty', 0, 100, 61],
    ['no time passed', 7, 100, 0],
  ] as const)('%s', (label, sync, total, since) => {
    pair('LibAccount.calcStaminaRecovery', label, chain(sync, total, since), port(sync, total, since));
  });

  it('LibStat.calcSync ↔ sync: clamps at both ends', () => {
    for (const [s, t, d] of [[5, 100, -9], [99, 100, 3], [40, 100, 7]] as const) {
      pair('LibStat.calcSync', `${s} + ${d} of ${t}`, refCalcSync(B(t), B(s), B(d)), statSync({ sync: s, total: t } as never, d));
    }
  });
});

describe('LibAffinity.calcEfficacyShift ↔ calcEfficacyShift (harvest shapes)', () => {
  // the port's own (unexported) enum: NEUTRAL 0, UP 1, DOWN 2, SPECIAL 3
  const PORT_EFF = { Neutral: 0, Strong: 1, Weak: 2, Special: 3 } as const;
  it.each([
    ['Strong (body)', 'Strong', 'KAMI_HARV_EFFICACY_BODY', 0],
    ['Strong + a 120 fertility bonus', 'Strong', 'KAMI_HARV_EFFICACY_BODY', 120],
    ['Weak (hand)', 'Weak', 'KAMI_HARV_EFFICACY_HAND', 0],
    ['Neutral (the bonus does not apply)', 'Neutral', 'KAMI_HARV_EFFICACY_BODY', 55],
  ] as const)('%s', (label, eff, key, bonus) => {
    const chain = refEfficacyShift(eff, getShifts(cfg(key)), { ...ZERO, up: B(bonus) });
    const portCfg = key.endsWith('BODY') ? LIVE.harvest.efficacy.body : LIVE.harvest.efficacy.hand;
    pair('LibAffinity.calcEfficacyShift', label, chain, units(calcEfficacyShift(PORT_EFF[eff] as never, portCfg, bonus / 1000), 3));
  });
});

describe('LibHarvest.calcEfficacy (both overloads) ↔ calcEfficacyShifts', () => {
  /** the port's fertility efficacy (boost + shifts), in the chain's 1e3 units */
  const portEfficacy = (body: string, hand: string, node: string[], bonus: number) => {
    const k = kami({ body, hand, bonus: { harvFertilityBoost: bonus }, harvest: { last: 60, reset: 60, nodeAff: node } });
    return (LIVE.harvest.fertility.boost.value + calcEfficacyShifts(k.harvest!, k)) * 1000;
  };

  it('typed traits on a typed node: Strong / Weak, as the chain', () => {
    pair('LibHarvest.calcEfficacy(uint256,uint256,uint256)', 'EERIE/SCRAP on EERIE', refHarvestEfficacy(1000n, 'EERIE', 'SCRAP', 'EERIE', 0n), units(portEfficacy('EERIE', 'SCRAP', ['EERIE'], 0) / 1000, 3));
    pair('LibHarvest.calcEfficacy(uint256,uint256,uint256)', 'INSECT/INSECT on SCRAP-INSECT, bonus 40', refHarvestEfficacy(1000n, 'INSECT', 'INSECT', 'SCRAP-INSECT', 40n), units(portEfficacy('INSECT', 'INSECT', ['SCRAP', 'INSECT'], 40) / 1000, 3));
    pair('LibHarvest.calcEfficacy(uint256,uint256,uint256)', 'SCRAP/EERIE on EERIE-SCRAP (the favourable order)', refHarvestEfficacy(1000n, 'SCRAP', 'EERIE', 'EERIE-SCRAP', 0n), units(portEfficacy('SCRAP', 'EERIE', ['EERIE', 'SCRAP'], 0) / 1000, 3));
  });

  it('a NORMAL trait with an EVEN fertility bonus: bonus / 2, as the chain', () => {
    pair('LibHarvest.calcEfficacy(string,string,Shifts,string)', 'NORMAL body, EERIE hand on EERIE, bonus 40', refHarvestEfficacy(1000n, 'NORMAL', 'EERIE', 'EERIE', 40n), units(portEfficacy('NORMAL', 'EERIE', ['EERIE'], 40) / 1000, 3));
  });

  it('RESOLVED in 1.1.0 (was rounding): a NORMAL trait with an ODD bonus — bonus/2 truncated toward zero, as the chain', () => {
    // NORMAL body + EERIE hand on an EERIE node, bonus 25: chain 1000 + 12 + (350 + 25) = 1387 (1.0.5: 1387.5)
    const chain = refHarvestEfficacy(1000n, 'NORMAL', 'EERIE', 'EERIE', 25n);
    pair('LibHarvest.calcEfficacy(string,string,Shifts,string)', 'NORMAL body, EERIE hand on EERIE, bonus 25', chain, units(portEfficacy('NORMAL', 'EERIE', ['EERIE'], 25) / 1000, 3));
    // a NEGATIVE odd bonus truncates toward zero: −25 / 2 = −12, twice (1.0.5: 975)
    const neg = refHarvestEfficacy(1000n, 'NORMAL', 'NORMAL', 'EERIE', -25n);
    pair('LibHarvest.calcEfficacy(string,string,Shifts,string)', 'NORMAL/NORMAL, bonus −25', neg, units(portEfficacy('NORMAL', 'NORMAL', ['EERIE'], -25) / 1000, 3));
  });

  it('RESOLVED in 1.1.0 (was missing clamp): a negative summed efficacy is floored at 0 — the fertility it yields is 0', () => {
    // two NORMAL traits and a −2500 bonus: 1000 − 1250 − 1250 < 0 → 0 on
    // chain; the shift sum itself is the client's, the clamp lives in the
    // fertility it feeds (1.0.5 served a NEGATIVE fertility here)
    const chainEff = refHarvestEfficacy(1000n, 'NORMAL', 'NORMAL', 'EERIE', -2500n);
    expect(chainEff).toBe(0n);
    const k = kami({ power: 30, body: 'NORMAL', hand: 'NORMAL', bonus: { harvFertilityBoost: -2500 }, harvest: { last: 60, reset: 60, nodeAff: ['EERIE'] } });
    pair('LibHarvest.calcEfficacy(uint256,uint256,uint256)', 'NORMAL/NORMAL, bonus −2500 (as the fertility it yields)', refFertility(30n, chainEff), units(calcFertility(k.harvest!, k), 6));
  });
});

describe('LibHarvest.calcDuration, calcIntensityDuration, calcFertility, calcIntensity, calcMaxMusu, calcBounty', () => {
  it('calcDuration ↔ calcIdleTime and calcIntensityDuration ↔ calcIntensityTime', () => {
    const k = kami({ harvest: { last: 1234, reset: 98_765, nodeAff: ['EERIE'] } });
    pair('LibHarvest.calcDuration', 'last 1234 s ago', 1234n, calcHarvestIdleTime(k.harvest!));
    pair('LibHarvest.calcIntensityDuration', 'reset 98765 s ago', 98_765n, calcIntensityTime(k.harvest!));
    // a harvest whose LastTime the mirror lacks: the port reads 0; the chain
    // would compute block.timestamp − 0
    const blank = { ...k.harvest!, time: { last: 0, reset: 0, start: 0 } } as never;
    pair('LibHarvest.calcDuration', 'no LastTime', B(NOW), calcHarvestIdleTime(blank), { cls: 'guard: an unset LastTime reads 0 in the port', port: 0 });
  });

  it.each([
    ['power 20, EERIE/SCRAP on EERIE', 20, 'EERIE', 'SCRAP', 'EERIE'],
    ['power 55, INSECT/INSECT on INSECT', 55, 'INSECT', 'INSECT', 'INSECT'],
    ['power 37, SCRAP/EERIE on EERIE-SCRAP', 37, 'SCRAP', 'EERIE', 'EERIE-SCRAP'],
  ] as const)('calcFertility: %s', (label, power, body, hand, node) => {
    const k = kami({ power, body, hand, harvest: { last: 600, reset: 600, nodeAff: node.split('-') } });
    pair('LibHarvest.calcFertility', label, refFertility(B(power), refHarvestEfficacy(1000n, body, hand, node, 0n)), units(calcFertility(k.harvest!, k), 6));
  });

  it('RESOLVED in 1.1.0 (was float floor): fertility at an exact integer rate', () => {
    // power 78, INSECT/EERIE on SCRAP: exactly 21125e-6 (1.0.5: 21124e-6)
    const k = kami({ power: 78, body: 'INSECT', hand: 'EERIE', harvest: { last: 600, reset: 600, nodeAff: ['SCRAP'] } });
    const chain = refFertility(78n, refHarvestEfficacy(1000n, 'INSECT', 'EERIE', 'SCRAP', 0n));
    pair('LibHarvest.calcFertility', 'power 78, INSECT/EERIE on SCRAP', chain, units(calcFertility(k.harvest!, k), 6));
  });

  it('calcIntensity, and the float-floor boundary RESOLVED in 1.1.0', () => {
    const k = kami({ violence: 22, harvest: { last: 60, reset: 9_999, nodeAff: ['EERIE'] } });
    pair('LibHarvest.calcIntensity', 'violence 22, reset 9999 s ago', refIntensity(22n, 9_999n), units(calcIntensity(k.harvest!, k).average, 6));
    // violence 57, reset 47750 s ago: exactly 6250e-6 (1.0.5: 6249e-6)
    const k2 = kami({ violence: 57, harvest: { last: 60, reset: 47_750, nodeAff: ['EERIE'] } });
    pair('LibHarvest.calcIntensity', 'violence 57, reset 47750 s ago', refIntensity(57n, 47_750n), units(calcIntensity(k2.harvest!, k2).average, 6));
  });

  it('calcMaxMusu, and the float-floor boundary RESOLVED in 1.1.0', () => {
    pair('LibHarvest.calcMaxMusu', 'hp 200, harmony 30', refMaxMusu(200n, 30n), calcMaxMusu(kami({ harmony: 30, hpSync: 200 })));
    // 1.0.5: 21249
    pair('LibHarvest.calcMaxMusu', 'hp 1649, harmony 45, strain bonus −224', refMaxMusu(1649n, 45n, -224n), calcMaxMusu(kami({ harmony: 45, hpTotal: 2000, hpSync: 1649, bonus: { strainBoost: -224 } })));
  });

  it.each([
    ['an hour on a matching node', 20, 15, 15, 'EERIE', 'SCRAP', 'EERIE', 3_600, 7_200],
    ['capped by max musu', 12, 9, 11, 'SCRAP', 'INSECT', 'EERIE', 86_400, 90_000],
    ['a fresh harvest', 55, 40, 50, 'INSECT', 'INSECT', 'INSECT', 500, 500],
  ] as const)('calcBounty ↔ calcOutput: %s', (label, power, violence, harmony, body, hand, node, last, reset) => {
    const k = kami({ power, violence, harmony, body, hand, harvest: { last, reset, nodeAff: [node] } });
    const fert = refFertility(B(power), refHarvestEfficacy(1000n, body, hand, node, 0n));
    pair('LibHarvest.calcBounty', label, refBounty(fert, refIntensity(B(violence), B(reset)), B(last), refMaxMusu(200n, B(harmony))), calcOutput(k));
  });

  it('RESOLVED in 1.1.0 (was float floor, inherited): a long harvest on the fertility boundary above', () => {
    // power 78, INSECT/EERIE on SCRAP harvesting 1,000,000 s (1.0.5: one MUSU low)
    const k = kami({ power: 78, violence: 10, harmony: 50, body: 'INSECT', hand: 'EERIE', hpTotal: 1_000_000, harvest: { last: 1_000_000, reset: 1_000_000, nodeAff: ['SCRAP'] } });
    const fert = refFertility(78n, refHarvestEfficacy(1000n, 'INSECT', 'EERIE', 'SCRAP', 0n));
    const chain = refBounty(fert, refIntensity(10n, 1_000_000n), 1_000_000n, refMaxMusu(1_000_000n, 50n));
    pair('LibHarvest.calcBounty', 'power 78, INSECT/EERIE on SCRAP, 1,000,000 s', chain, calcOutput(k));
  });

  it('seeded sweep — fertility: equal in every sample (1.0.5: 84 one unit low)', () => {
    sweep('LibHarvest.calcFertility', 'equal (resolved in 1.1.0; 1.0.5: float floor at RATE_PREC, 84 low)', 4000, (rnd) => {
      const power = rnd(5, 120), body = AFF[rnd(0, 2)]!, hand = AFF[rnd(0, 2)]!, node = AFF[rnd(0, 2)]!, bonus = rnd(0, 400);
      const k = kami({ power, body, hand, bonus: { harvFertilityBoost: bonus }, harvest: { last: 60, reset: 60, nodeAff: [node] } });
      return { label: `power ${power}, ${body}/${hand} on ${node}, +${bonus}`, chain: refFertility(B(power), refHarvestEfficacy(1000n, body, hand, node, B(bonus))), port: units(calcFertility(k.harvest!, k), 6) };
    }, [0], 0);
  });

  it('seeded sweep — intensity: equal in every sample (1.0.5: 15 one unit low)', () => {
    sweep('LibHarvest.calcIntensity', 'equal (resolved in 1.1.0; 1.0.5: float floor at RATE_PREC, 15 low)', 4000, (rnd) => {
      const violence = rnd(5, 120), reset = rnd(60, 200_000);
      const k = kami({ violence, harvest: { last: 60, reset, nodeAff: ['EERIE'] } });
      return { label: `violence ${violence}, reset ${reset} s ago`, chain: refIntensity(B(violence), B(reset)), port: units(calcIntensity(k.harvest!, k).average, 6) };
    }, [0], 0);
  });

  it('seeded sweep — bounty: equal in every sample', () => {
    sweep('LibHarvest.calcBounty', 'equal', 4000, (rnd) => {
      const power = rnd(5, 120), violence = rnd(5, 120), harmony = rnd(5, 80);
      const body = AFF[rnd(0, 2)]!, hand = AFF[rnd(0, 2)]!, node = AFF[rnd(0, 2)]!;
      const last = rnd(60, 100_000), reset = last + rnd(0, 100_000), bb = rnd(-100, 400);
      const k = kami({ power, violence, harmony, body, hand, hpTotal: 1_000_000, bonus: { harvBountyBoost: bb }, harvest: { last, reset, nodeAff: [node] } });
      const fert = refFertility(B(power), refHarvestEfficacy(1000n, body, hand, node, 0n));
      const chain = refBounty(fert, refIntensity(B(violence), B(reset)), B(last), refMaxMusu(1_000_000n, B(harmony)), B(bb));
      return { label: `${power}/${violence}/${harmony} ${body}/${hand} on ${node}, last ${last}, reset ${reset}, +${bb}`, chain, port: calcOutput(k) };
    }, [0], 0);
  });

  it('seeded sweep — max musu: equal in every sample', () => {
    sweep('LibHarvest.calcMaxMusu', 'equal', 4000, (rnd) => {
      const hp = rnd(1, 3000), harmony = rnd(5, 80), sb = rnd(-300, 300);
      const k = kami({ harmony, hpTotal: 5000, hpSync: hp, bonus: { strainBoost: sb } });
      return { label: `hp ${hp}, harmony ${harmony}, ${sb}`, chain: refMaxMusu(B(hp), B(harmony), B(sb)), port: calcMaxMusu(k) };
    }, [0], 0);
  });
});

describe('LibKami.calcStrain, calcMetabolism, calcRecovery', () => {
  it.each([
    ['an exact quotient', 100, 30, 0],
    ['a remainder rounds up', 37, 15, 0],
    ['with a −100 strain bonus', 1000, 30, -100],
    ['with a +50 strain bonus', 999, 12, 50],
  ] as const)('calcStrain ↔ calcStrainFromBalance: %s', (label, amt, harmony, bonus) => {
    pair('LibKami.calcStrain', label, refStrain(B(amt), B(harmony), B(bonus)), calcStrainFromBalance(kami({ harmony, bonus: { strainBoost: bonus } }), amt, true));
  });

  it('seeded sweep — strain: equal in every sample', () => {
    sweep('LibKami.calcStrain', 'equal', 4000, (rnd) => {
      const amt = rnd(1, 20000), harmony = rnd(5, 80), sb = rnd(-300, 300);
      return { label: `${amt}, harmony ${harmony}, ${sb}`, chain: refStrain(B(amt), B(harmony), B(sb)), port: calcStrainFromBalance(kami({ harmony, bonus: { strainBoost: sb } }), amt, true) };
    }, [0], 0);
  });

  it('DIVERGENCE, NOT SERVED as a number (client-only approximation): calcMetabolism — the display rate is not floored at METABOLISM_PREC', () => {
    // harmony 15: chain 5833333e-9 HP/s; the port keeps 5833333.33…e-9 (a display rate)
    const port = calcHealthRate(kami({ harmony: 15 })) * 1e9;
    const chain = refMetabolism(15n);
    expect(Math.floor(port)).toBe(Number(chain));
    expect(port - Number(chain)).toBeLessThan(1);
    pair('LibKami.calcMetabolism', 'harmony 15', chain, port, { cls: 'unfloored rate (display)', port });
  });

  it.each([
    ['10 minutes resting', 15, 50, 600],
    ['an hour and a second', 30, 10, 3_601],
    ['one second', 11, 100, 1],
    ['clamped at the total', 25, 0, 86_400],
  ] as const)('calcRecovery ↔ calcHealth (RESTING): %s', (label, harmony, sync, idle) => {
    const k = kami({ state: 'RESTING', harmony, hpTotal: 200, hpSync: sync, idle });
    pair('LibKami.calcRecovery', label, refRestingHealth(B(sync), 200n, B(harmony), B(idle)), calcHealth(k));
  });

  it('seeded sweep — resting health: equal in every sample', () => {
    sweep('LibKami.calcRecovery', 'equal', 4000, (rnd) => {
      const harmony = rnd(5, 80), sync = rnd(0, 500), idle = rnd(1, 200_000), mb = rnd(-200, 500);
      const k = kami({ state: 'RESTING', harmony, hpTotal: 100_000, hpSync: sync, idle, bonus: { metabolismBoost: mb } });
      return { label: `harmony ${harmony}, hp ${sync}, ${idle} s, ${mb}`, chain: refRestingHealth(B(sync), 100_000n, B(harmony), B(idle), B(mb)), port: calcHealth(k) };
    }, [0], 0);
  });
});

describe('LibKill: threshold (with animosity and threshold efficacy), recoil efficacy, karma, recoil, salvage, spoils', () => {
  it.each([
    ['EERIE hand on a SCRAP body (Strong)', 20, 'EERIE', 18, 'SCRAP', 200],
    ['NORMAL on NORMAL (Special)', 35, 'NORMAL', 30, 'NORMAL', 350],
    ['SCRAP hand on an EERIE body (Weak)', 10, 'SCRAP', 10, 'EERIE', 150],
    ['a weak attacker (low animosity)', 5, 'INSECT', 80, 'INSECT', 400],
  ] as const)('calcThreshold: %s', (label, aV, aHand, dH, dBody, hp) => {
    pair('LibKill.calcThreshold', label, refThreshold(B(aV), aHand, B(dH), dBody, B(hp)), calcThreshold(kami({ violence: aV, hand: aHand }), kami({ harmony: dH, body: dBody, hpTotal: hp })));
  });

  it('calcThreshold with ratio and shift bonuses on both sides', () => {
    const att = kami({ violence: 30, hand: 'EERIE', bonus: { atkThresholdRatio: 120, atkThresholdShift: 15 } });
    const def = kami({ harmony: 25, body: 'SCRAP', hpTotal: 300, bonus: { defThresholdRatio: 40, defThresholdShift: 5 } });
    pair('LibKill.calcThreshold', 'ratio +120/−40, shift +15/−5', refThreshold(30n, 'EERIE', 25n, 'SCRAP', 300n, { atkRatio: 120n, defRatio: 40n, atkShift: 15n, defShift: 5n }), calcThreshold(att, def));
  });

  it('RESOLVED in 1.1.0 (SERVED; found by G2.a on the 22,222-kami snapshot): a defender\'s threshold-shift bonus — the chain clamps at 0, and floors exactly', () => {
    // DEF_THRESHOLD_RATIO 300 / DEF_THRESHOLD_SHIFT 200, a common skill pair.
    // A weak attacker: base · ratio < shift → the chain returns 0 (LibKill:
    // `if (postShiftVal < 0) return 0`); 1.0.5 served a NEGATIVE threshold
    const weak = kami({ violence: 10, hand: 'EERIE' });
    const shielded = (harmony: number, body: string, hpTotal: number) =>
      kami({ harmony, body, hpTotal, bonus: { defThresholdRatio: 300, defThresholdShift: 200 } });
    pair('LibKill.calcThreshold', 'violence 10 vs harmony 40 behind a 300/200 defense bonus', refThreshold(10n, 'EERIE', 40n, 'EERIE', 300n, { defRatio: 300n, defShift: 200n }), calcThreshold(weak, shielded(40, 'EERIE', 300)));
    // equal stats, SCRAP on INSECT: (0.2 · 1.2 − 0.2) · 200 = 8 exactly on
    // chain; 1.0.5's floats made it 7.9999… → 7
    pair('LibKill.calcThreshold', 'violence 18 vs harmony 18, SCRAP on INSECT, 300/200 defense bonus', refThreshold(18n, 'SCRAP', 18n, 'INSECT', 200n, { defRatio: 300n, defShift: 200n }), calcThreshold(kami({ violence: 18, hand: 'SCRAP' }), shielded(18, 'INSECT', 200)));
  });

  it('seeded sweep — threshold with defense bonuses: equal in every sample', () => {
    sweep('LibKill.calcThreshold', 'equal with ratio/shift bonuses (resolved in 1.1.0: the clamp at 0 and the float floor)', 4000, (rnd) => {
      const aV = rnd(5, 120), dH = rnd(5, 120), hp = rnd(50, 2000), aHand = AFF4[rnd(0, 3)]!, dBody = AFF4[rnd(0, 3)]!;
      const ar = rnd(0, 400), dr = rnd(0, 400), as = rnd(0, 300), ds = rnd(0, 300);
      const att = kami({ violence: aV, hand: aHand, bonus: { atkThresholdRatio: ar, atkThresholdShift: as } });
      const def = kami({ harmony: dH, body: dBody, hpTotal: hp, bonus: { defThresholdRatio: dr, defThresholdShift: ds } });
      return { label: `${aV} ${aHand} vs ${dH} ${dBody}, hp ${hp}, ratio ${ar}/${dr}, shift ${as}/${ds}`, chain: refThreshold(B(aV), aHand, B(dH), dBody, B(hp), { atkRatio: B(ar), defRatio: B(dr), atkShift: B(as), defShift: B(ds) }), port: calcThreshold(att, def) };
    }, [0], 0);
  });

  it('seeded sweep — threshold: equal in every sample', () => {
    sweep('LibKill.calcThreshold', 'equal', 4000, (rnd) => {
      const aV = rnd(5, 120), dH = rnd(5, 120), hp = rnd(50, 2000), aHand = AFF4[rnd(0, 3)]!, dBody = AFF4[rnd(0, 3)]!;
      return { label: `${aV} ${aHand} vs ${dH} ${dBody}, hp ${hp}`, chain: refThreshold(B(aV), aHand, B(dH), dBody, B(hp)), port: calcThreshold(kami({ violence: aV, hand: aHand }), kami({ harmony: dH, body: dBody, hpTotal: hp })) };
    }, [0], 0);
  });

  it('calcRecoilEfficacy: equal for every affinity pairing', () => {
    for (const dHand of AFF4) for (const aBody of AFF4) {
      const port = calcRecoilEfficacy(kami({ body: aBody }), kami({ hand: dHand }), LIVE.liquidation.recoil.nudge.value);
      pair('LibKill.calcRecoilEfficacy', `${dHand} hand vs ${aBody} body`, refRecoilEfficacy(dHand, aBody, cfg('KAMI_LIQ_RECOIL')[0]!), units(port, 3));
    }
  });

  it('RESOLVED in 1.1.0 (was client-only approximation): calcKarma floored at KARMA_PREC, on the contracts\' own cdf', () => {
    for (const [dV, aH] of [[15, 15], [25, 22], [40, 30], [73, 9]] as const) {
      // 1.0.5: 1101.719…, 1226.409…, 1963.67… (unfloored)
      const port = calcKarma(kami({ harmony: aH }), kami({ violence: dV }));
      pair('LibKill.calcKarma', `defender violence ${dV}, attacker harmony ${aH}`, refKarma(B(dV), B(aH)), units(port, 3));
    }
  });

  it('RESOLVED in 1.1.0 (SERVED; was client-only approximation): calcRecoil on a floored karma', () => {
    // defender violence 73 vs attacker harmony 9, neutral affinities: the
    // attacker's strain comes from its spoils of the bounty. At a bounty of
    // 1,133 the chain's recoil is 402; 1.0.5 served 403 (karma unfloored)
    const att = kami({ harmony: 9, power: 20, body: 'SCRAP' });
    for (const bounty of [1133, 3000]) {
      const def = kami({ violence: 73, power: 18, hand: 'SCRAP', harvest: { balance: bounty, last: 0, reset: 0, nodeAff: ['NORMAL'] } });
      const { spoils } = refLiquidationShares(18n, 20n, B(bounty));
      const chain = refRecoil(73n, 'SCRAP', 9n, 'SCRAP', refStrain(spoils, 9n));
      pair('LibKill.calcRecoil', `defender violence 73, attacker harmony 9, bounty ${bounty}`, chain, calcRecoil(att, def));
    }
  });

  it('salvage and spoils: equal at ordinary power', () => {
    const def = kami({ power: 18, harvest: { balance: 1000, last: 0, reset: 0, nodeAff: ['NORMAL'] } });
    const { salvage, spoils } = refLiquidationShares(18n, 20n, 1000n);
    pair('LibKill.calcSalvage', 'victim power 18, bounty 1000', salvage, calcSalvage(def, 1000));
    pair('LibKill.calcSpoils', 'killer power 20, victim power 18, bounty 1000', spoils, calcSpoils(kami({ power: 20 }), def));
  });

  it('seeded sweep — the liquidation preview on the live config (salvage, spoils, strain, recoil)', () => {
    const gen = (field: 'salvage' | 'spoils' | 'recoil') => (rnd: (lo: number, hi: number) => number) => {
      const aV = rnd(5, 80), aH = rnd(5, 80), aP = rnd(5, 50), dV = rnd(5, 80), dH = rnd(5, 80), dP = rnd(5, 50);
      const aHand = AFF4[rnd(0, 3)]!, aBody = AFF4[rnd(0, 3)]!, dHand = AFF4[rnd(0, 3)]!, dBody = AFF4[rnd(0, 3)]!;
      const balance = rnd(1, 20000), sb = rnd(-200, 200);
      const att = kami({ violence: aV, harmony: aH, power: aP, body: aBody, hand: aHand, bonus: { strainBoost: sb } });
      const def = kami({ violence: dV, harmony: dH, power: dP, body: dBody, hand: dHand, harvest: { balance, last: 0, reset: 0, nodeAff: ['NORMAL'] } });
      const { salvage, spoils } = refLiquidationShares(B(dP), B(aP), B(balance));
      const label = `attacker ${aV}/${aH}/${aP} ${aHand}/${aBody}, defender ${dV}/${dH}/${dP} ${dHand}/${dBody}, bounty ${balance}, strain bonus ${sb}`;
      if (field === 'salvage') return { label, chain: salvage, port: calcSalvage(def, balance) };
      if (field === 'spoils') return { label, chain: spoils, port: calcSpoils(att, def) };
      // the strain the recoil is computed on is the port's own, on its own spoils
      expect(calcLiqStrain(att, def)).toBe(Number(refStrain(B(calcSpoils(att, def)), B(aH), B(sb))));
      return { label, chain: refRecoil(B(dV), dHand, B(aH), aBody, refStrain(spoils, B(aH), B(sb))), port: calcRecoil(att, def) };
    };
    sweep('LibKill.calcSalvage', 'equal', 3000, gen('salvage'), [0], 0);
    sweep('LibKill.calcSpoils', 'equal (resolved in 1.1.0; 1.0.5: float floor, 2 low)', 3000, gen('spoils'), [0], 0);
    sweep('LibKill.calcRecoil', 'equal (resolved in 1.1.0; 1.0.5: unfloored karma, 858 high by 1–3)', 3000, gen('recoil'), [0], 0);
  });

  it('RESOLVED in 1.1.0 (SERVED; was missing branch): spoils ratio in (1.0, 2.0) — amt × ratio, as the chain pays', () => {
    // killer power 60 on the live config [45, 2, 0, 3]: ratio (45 + 60)·10 =
    // 1050; 1050 / 1000 = 1, not > 1, so the chain pays 1.05 × what remains
    // (1.0.5: 750, capped at what remains)
    const def = kami({ power: 25, harvest: { balance: 1000, last: 0, reset: 0, nodeAff: ['NORMAL'] } });
    const { spoils } = refLiquidationShares(25n, 60n, 1000n);
    expect(spoils).toBe(787n);
    pair('LibKill.calcSpoils', 'killer power 60, victim power 25, bounty 1000', spoils, calcSpoils(kami({ power: 60 }), def));
    for (const power of [154, 155]) {
      pair('LibKill.calcSpoils', `killer power ${power}, victim power 25, bounty 1000`, refLiquidationShares(25n, B(power), 1000n).spoils, calcSpoils(kami({ power }), def));
    }
    // at power 154 the chain pays 1.99 ×; from 155 (ratio 2000) the full amount again
    expect(refShare('KAMI_LIQ_SPOILS', 154n, 1000n)).toBe(1990n);
    expect(refShare('KAMI_LIQ_SPOILS', 155n, 1000n)).toBe(1000n);
  });

  it('RESOLVED in 1.1.0 (SERVED; was missing branch): salvage ratio ≥ 1.0 — the chain\'s salvage, and the revert it causes', () => {
    // victim power 120: ratio 1200, salvage 1.2 × the bounty — the chain's
    // calcSalvage value — and the system's `bounty - salvage` underflows: the
    // liquidation reverts. The calc serves the chain's salvage; the preview
    // marks the row ineligible (SALVAGE_EXCEEDS_BOUNTY) and its spoils are 0
    // (test/liquidation-revert.test.ts asserts the served row)
    const def120 = kami({ power: 120, harvest: { balance: 1000, last: 0, reset: 0, nodeAff: ['NORMAL'] } });
    expect(() => refLiquidationShares(120n, 20n, 1000n)).toThrow(/underflow/);
    pair('LibKill.calcSalvage', 'victim power 120 (the liquidation reverts on chain)', refShare('KAMI_LIQ_SALVAGE', 120n, 1000n), calcSalvage(def120, 1000));
    pair('LibKill.calcSpoils', 'killer power 20 on that victim (the chain reverts first; 0 served)', 0n, calcSpoils(kami({ power: 20 }), def120));
    // victim power 250: ratio 2500, 2500 / 1000 = 2 > 1 → the whole bounty (1.0.5: 2500)
    const def250 = kami({ power: 250, harvest: { balance: 1000, last: 0, reset: 0, nodeAff: ['NORMAL'] } });
    pair('LibKill.calcSalvage', 'victim power 250', refShare('KAMI_LIQ_SALVAGE', 250n, 1000n), calcSalvage(def250, 1000));
  });
});

describe('LibExperience.calcLevelCost ↔ calcExperienceRequirement', () => {
  const m = makeMirror(1);
  it.each([1, 2, 10, 30, 60])('level %i', (level) => {
    pair('LibExperience.calcLevelCost', `level ${level}`, refLevelCost(level), calcExperienceRequirement(m.world, m.components, level));
  });
  it('RESOLVED in 1.1.0: equal through level 200 (1.0.5: one XP low from level 119, Math.pow vs powWad)', () => {
    for (let level = 1; level <= 200; level++) {
      expect(calcExperienceRequirement(m.world, m.components, level), `level ${level}`).toBe(Number(refLevelCost(level)));
    }
    pair('LibExperience.calcLevelCost', 'level 119', refLevelCost(119), calcExperienceRequirement(m.world, m.components, 119));
  });
});

describe('LibStat.calcTotal ↔ getStatFromUint().total', () => {
  const packed = (base: number, shift: number, boost: number) =>
    (BigInt.asUintN(64, B(base)) << 192n) | (BigInt.asUintN(64, B(shift)) << 128n) | (BigInt.asUintN(64, B(boost)) << 64n);
  it('boosts that leave no fraction: equal', () => {
    pair('LibStat.calcTotal', 'base 70, shift 110, boost 0', refStatTotal(70n, 110n, 0n), getStatFromUint(packed(70, 110, 0)).total);
    pair('LibStat.calcTotal', 'base 20, shift 5, boost 200', refStatTotal(20n, 5n, 200n), getStatFromUint(packed(20, 5, 200)).total);
  });
  it('RESOLVED in 1.1.0 (SERVED; was rounding): a boost that leaves a fraction — truncated to whole points', () => {
    // 1.0.5: 13.65 and 29.7
    pair('LibStat.calcTotal', 'base 13, boost 50', refStatTotal(13n, 0n, 50n), getStatFromUint(packed(13, 0, 50)).total);
    pair('LibStat.calcTotal', 'base 33, boost −100', refStatTotal(33n, 0n, -100n), getStatFromUint(packed(33, 0, -100)).total);
    pair('LibStat.calcTotal', 'base −7, boost 150 (toward zero)', refStatTotal(-7n, 0n, 150n), getStatFromUint(packed(-7, 0, 150)).total);
  });
  it('RESOLVED in 1.1.0 (SERVED; was missing clamp): a negative base + shift — floored at 0', () => {
    // 1.0.5: −3
    pair('LibStat.calcTotal', 'base −5, shift 2', refStatTotal(-5n, 2n, 0n), getStatFromUint(packed(-5, 2, 0)).total);
  });
});

describe('LibListing.calcBuyPrice / calcSellPrice, LibAuction.calcBuy (and LibGDA.calc through them)', () => {
  it('FIXED buy and sell: equal', () => {
    const fixed: GdaIn = { type: 'FIXED', value: 37 };
    pair('LibListing.calcBuyPrice', 'FIXED 37 × 3', refListingBuy(fixed, 3), calcBuyPrice(listingOf(fixed), 3));
    pair('LibListing.calcSellPrice', 'FIXED 37 × 3', 111n, calcSellPrice(listingOf(fixed, { type: 'FIXED' }), 3));
  });

  it.each([
    ['two periods, below rate', 100, 3_600, 900_000, 10, 5, 7_200],
    ['ahead of rate', 37, 600, 950_000, 3, 50, 600],
    ['a multi-day decay, clamped (an exact cap)', 1_000, 86_400, 500_000, 1, 0, 300_000],
  ] as const)('GDA buy (amount 1): %s', (label, value, period, decay, rate, prevSold, since) => {
    const p = gda(value, period, decay, rate, prevSold, since);
    pair('LibListing.calcBuyPrice', label, refListingBuy(p, 1), calcBuyPrice(listingOf(p), 1));
  });

  it('RESOLVED in 1.1.0 (SERVED; was precision slot): the deficit clamp counted in whole seconds', () => {
    // prevSold·period/rate = 20·3600/69 = 1043.47… s, floored to 1043 as the
    // chain floors it (1.0.5 clamped the exponent at exactly 3 periods: one unit low)
    const p = gda(13_985, 3_600, 955_868, 69, 20, 18_589);
    pair('LibListing.calcBuyPrice', 'clamped, 20·3600 / 69 not whole', refListingBuy(p, 1), calcBuyPrice(listingOf(p), 1));
  });

  it('RESOLVED in 1.1.0 (SERVED; was rounding): SCALED sell — (buy × scale) / 1e9, floored', () => {
    const p = gda(100, 3_600, 900_000, 10, 5, 7_200);
    const buy = refListingBuy(p, 1);
    // 1.0.5: 25.8
    pair('LibListing.calcSellPrice', 'SCALED 0.3 of a buy price of 86', (buy * 300_000_000n) / 1_000_000_000n, calcSellPrice(listingOf(p, { type: 'SCALED', scale: 0.3 }), 1));
    pair('LibListing.calcSellPrice', 'SCALED 0.123456789 of 86, amount 1', (buy * 123_456_789n) / 1_000_000_000n, calcSellPrice(listingOf(p, { type: 'SCALED', scale: 0.123456789 }), 1));
  });

  it.each([
    ['two periods, below rate', 100, 3_600, 900_000, 10, 5, 7_200],
    ['a multi-day decay (no clamp on auctions)', 1_000, 86_400, 500_000, 1, 0, 300_000],
    ['ahead of rate', 37, 600, 950_000, 3, 50, 600],
  ] as const)('LibAuction.calcBuy ↔ auctions calcPrice: %s', (label, value, period, decay, rate, sold, since) => {
    const a: AuctionIn = { value, startTs: NOW - since, period, decay, rate, sold };
    pair('LibAuction.calcBuy', label, refAuctionBuy(a, 1), calcAuctionPrice(auctionOf(a), NOW, sold, 1));
  });

  it('RESOLVED in 1.1.0 (SERVED; was missing revert): an auction decayed below one unit — the chain reverts, the served price is null', () => {
    // 600 periods at 0.5: the cost underflows to 0 in SD59x18 and calcBuy
    // reverts. The ported curve (calcAuctionPrice, the client's) still says
    // 1; the auctions answer (auctionPriceOut) serves null with the reason
    const a: AuctionIn = { value: 4_697, startTs: NOW - 36_000, period: 60, decay: 500_000, rate: 7, sold: 0 };
    expect(() => refAuctionBuy(a, 1)).toThrow(/negative GDA cost/);
    expect(calcAuctionPrice(auctionOf(a), NOW, 0, 1)).toBe(1);
    const served = auctionPriceOut(auctionOf(a), NOW);
    pair('LibAuction.calcBuy', 'decayed 600 periods at 0.5 (served)', 'revert', served.price === null ? `revert:${served.priceUnavailable}` : String(served.price), { cls: 'resolved: served null with priceUnavailable', port: 'revert:COST_ROUNDS_TO_ZERO' });
    // an ordinary auction is served its price, unchanged
    const ok: AuctionIn = { value: 100, startTs: NOW - 7_200, period: 3_600, decay: 900_000, rate: 10, sold: 5 };
    expect(auctionPriceOut(auctionOf(ok), NOW)).toEqual({ price: Number(refAuctionBuy(ok, 1)) });
  });

  it('seeded sweeps — merchant buy price (amount 1) and auction price, at prices up to 1e9', () => {
    const listingGen = (clamped: boolean) => (rnd: (lo: number, hi: number) => number) => {
      const value = rnd(1, 20_000), period = [3_600, 86_400][rnd(0, 1)]!, decay = rnd(800_000, 999_000), rate = rnd(1, 100);
      const prevSold = rnd(0, 2_000), since = rnd(0, 6 * period);
      const isClamped = since > Math.floor((prevSold * period) / rate) + 3 * period;
      // the clamped set keeps only caps that are not whole seconds — the class
      if (clamped !== isClamped || (isClamped && (prevSold * period) % rate === 0)) return null;
      const p = gda(value, period, decay, rate, prevSold, since);
      let chain: bigint;
      try {
        chain = refListingBuy(p, 1);
      } catch {
        return null; // a price the chain cannot compute is no listing a merchant shows
      }
      if (chain > 1_000_000_000n) return null;
      return { label: `${value}, period ${period}, decay ${decay}, rate ${rate}, sold ${prevSold}, ${since} s`, chain, port: calcBuyPrice(listingOf(p), 1) };
    };
    sweep('LibListing.calcBuyPrice', 'equal (unclamped)', 4000, listingGen(false), [0], 0);
    sweep('LibListing.calcBuyPrice', 'equal (clamped, not whole; resolved in 1.1.0 — 1.0.5: 52 one unit low)', 20_000, listingGen(true), [0], 0);
    sweep('LibAuction.calcBuy', 'equal', 4000, (rnd) => {
      const value = rnd(1, 20_000), period = [3_600, 86_400][rnd(0, 1)]!, decay = rnd(800_000, 999_000), rate = rnd(1, 100);
      const sold = rnd(0, 2_000), since = rnd(0, 6 * period);
      const a: AuctionIn = { value, startTs: NOW - since, period, decay, rate, sold };
      let chain: bigint;
      try {
        chain = refAuctionBuy(a, 1);
      } catch {
        return null;
      }
      if (chain > 1_000_000_000n) return null;
      return { label: `${value}, period ${period}, decay ${decay}, rate ${rate}, sold ${sold}, ${since} s`, chain, port: calcAuctionPrice(auctionOf(a), NOW, sold, 1) };
    }, [0], 0);
  });
});

describe('LibPool.calcAmountOut, LibBonus.calcSingle, LibRandom.calcRarityWeight, LibTrade.calcTax, LibTokenPortal.calcWithdrawalDelay', () => {
  it.each([
    [1_000, 20_000, 5_000, 30],
    [1, 1_000_000, 3, 30],
    [123_456, 987_654, 55_555, 0],
  ] as const)('calcAmountOut(%i in, reserves %i / %i, %i bps)', (amountIn, rIn, rOut, fee) => {
    const withFee = B(amountIn) * (10_000n - B(fee));
    pair('LibPool.calcAmountOut', `${amountIn} in, reserves ${rIn}/${rOut}, fee ${fee}`, (withFee * B(rOut)) / (B(rIn) * 10_000n + withFee), calcAmountOut(amountIn, rIn, rOut, fee));
  });

  it('calcSingle ↔ Bonus getValue: value × level, signed', () => {
    for (const [value, level] of [[250, 3], [-40, 5], [1, 1]] as const) {
      const m = makeMirror(1);
      const regId = hashArgs(['test.bonus.registry', value + 1000], ['string', 'uint32']);
      const reg = m.world.registerEntity({ id: regId });
      setComponent(m.components.IsRegistry, reg, { value: true });
      setComponent(m.components.Value, reg, { value: ('0x' + BigInt.asUintN(256, B(value)).toString(16)) as unknown as number });
      const inst = m.world.registerEntity({ id: hashArgs(['test.bonus.instance', value + 1000], ['string', 'uint32']) });
      setComponent(m.components.SourceID, inst, { value: regId });
      setComponent(m.components.Level, inst, { value: level });
      pair('LibBonus.calcSingle', `value ${value} × level ${level}`, B(value) * B(level), getBonusValue(m.world, m.components, inst));
    }
  });

  it('calcRarityWeight ↔ the odds getDTDetails derives (1 << (tier − 1)); tiers at the pin are ≤ 9', () => {
    const m = makeMirror(1);
    const tiers = [9, 6, 1, 0];
    const w = tiers.map((r) => (r === 0 ? 0n : 1n << B(r - 1)));
    const total = w.reduce((a, b) => a + b, 0n);
    const chain = w.map((x) => `${((Number(x) / Number(total)) * 100).toFixed(1)}%`).join(' ');
    const port = getDTDetails(m.world, m.components, { keys: [1, 2, 3, 4], weights: tiers } as never).map((d) => d.description).join(' ');
    pair('LibRandom.calcRarityWeight', 'tiers 9, 6, 1, 0 (as odds)', chain, port);
    // JavaScript's << is 32-bit: a tier of 32 would weigh −2^31 in the port
    expect(1 << 31).toBe(-2147483648);
  });

  it('calcTax ↔ trade calcTax (a display helper, not served): MUSU only, and a float floor', () => {
    const MUSU = { index: 1 } as never;
    pair('LibTrade.calcTax', 'MUSU 12345 at 25/1000', (12_345n * 25n) / 1000n, calcTradeTax(MUSU, 12_345, 25 / 1000));
    pair('LibTrade.calcTax', 'item 2 (not MUSU)', 0n, calcTradeTax({ index: 2 } as never, 12_345, 25 / 1000));
    pair('LibTrade.calcTax', 'MUSU 100 at 29/100', (100n * 29n) / 100n, calcTradeTax(MUSU, 100, 29 / 100), { cls: 'float floor (0.29 × 100 = 28.999…)', port: 28 });
  });

  it('calcWithdrawalDelay ↔ portal getConfig().delay: the same config field', () => {
    clearConfigCaches();
    const m = makeMirror(1);
    const setConfig = (field: string, value: string) => {
      const e = m.world.registerEntity({ id: hashArgs(['is.config', field], ['string', 'string']) });
      setComponent(m.components.Value, e, { value: value as unknown as number });
    };
    setConfig('PORTAL_ITEM_IMPORT_TAX', packArray32([0, 100, 0, 0, 0, 0, 0, 0]));
    setConfig('PORTAL_ITEM_EXPORT_TAX', packArray32([0, 250, 0, 0, 0, 0, 0, 0]));
    setConfig('PORTAL_TOKEN_EXPORT_DELAY', '0x' + (86_400).toString(16));
    pair('LibTokenPortal.calcWithdrawalDelay', 'config 86400', 86_400n, getPortalConfig(m.world, m.components).delay);
    clearConfigCaches();
  });
});
