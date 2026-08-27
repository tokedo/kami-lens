// kami-lens native module (not a port): query output builders (DESIGN §4.3).
//
// Each builder materializes a compact, schema-checked output from the
// mirror, through the same ported data path the web client renders from
// (app/cache getters with forced refresh — the G2.b-verified path), so
// query answers inherit display parity. Output shapes are deliberate,
// versioned kami-lens surfaces (checked-in JSON schemas in
// src/queries/schemas; string classes in docs/string-classification.json);
// they are NOT the raw upstream shapes.

import * as clock from 'clock';

import { tripwires } from '../tripwires';
import { calcCurrentStamina } from 'app/cache/account';
import { cleanInventories } from 'app/cache/inventory';
import {
  calcCooldown,
  calcHealth,
  calcHealthPercent,
  calcOutput,
  getKami,
  getKamiAccount,
  getKamiBodyAffinity,
  getKamiHandAffinity,
} from 'app/cache/kami';
import { KamiCache } from 'app/cache/kami/base';
// liquidation previews import from the calcs module directly — the barrel
// exports only threshold/canLiquidate; upstream's LiquidateButton imports
// spoils/recoil the same way
import {
  calcLiqRecoil,
  calcLiqSalvage,
  calcLiqSpoils,
  calcLiqThreshold,
  canLiquidate,
  isResting,
  isStarving,
  onCooldown,
} from 'app/cache/kami/calcs';
import { calcListingBuyPrice, calcListingSellPrice } from 'app/cache/npc';
import { EntityIndex, HasValue, World, getComponentValue, runQuery } from 'engine/recs';
import { formatEntityID } from 'engine/utils';
import { id as keccakOfString } from 'ethers';
import { Components } from 'network/';
import {
  getAccount,
  getAccountByID,
  getAccountByIndex,
  getAccountByName,
  getAccountByOperator,
  getAccountByOwner,
  queryRoomAccounts,
} from 'network/shapes/Account';
import { queryByIndex as queryAccountEntityByIndex } from 'network/shapes/Account/queries';
import { parseAllo } from 'network/shapes/Allo';
import type { Allo } from 'network/shapes/Allo';
import { parseConditionalText } from 'network/shapes/Conditional';
import type { Condition } from 'network/shapes/Conditional';
import { getConfigFieldValue, getConfigFieldValueArray } from 'network/shapes/Config';
// getHarvestKami (Harvest/kami.ts), NOT getHarvest's {kami:true} option —
// that option is a dormant upstream defect (see Harvest/types.ts header).
import { getHarvest, getHarvestKami } from 'network/shapes/Harvest';
import { getAllItems, getItemBalance, getItemByIndex } from 'network/shapes/Item';
import type { Item as ShapeItem } from 'network/shapes/Item';
import { getKami as getShapeKami } from 'network/shapes/Kami';
import { calcExperienceRequirement } from 'network/shapes/Kami/progress';
import { queryByIndex as queryKamiByIndex } from 'network/shapes/Kami/queries';
import { Listing } from 'network/shapes/Listing';
import { getNodeByIndex } from 'network/shapes/Node';
import { queryHarvests } from 'network/shapes/Node/harvests';
import { queryByIndex as queryNodeEntityByIndex } from 'network/shapes/Node/queries';
import { getDisplayedKamiIndices } from 'network/shapes/NewbieVendor/queries';
import { getAllNPCs, getNPCByIndex } from 'network/shapes/Npc';
import { getRoomByIndex } from 'network/shapes/Room';
import { getExitsFor } from 'network/shapes/Room/exit';
import { getRegistrySkills, getSkillByIndex } from 'network/shapes/Skill';
import { parseBonusText } from 'network/shapes/Bonus';
import { getScoresByFilter } from 'network/shapes/Score';
import { getIsDisabled } from 'network/shapes/utils/component';
import { getEntityByHash } from 'network/shapes/utils';
import { getRateDisplay } from 'utils/numbers';
import { getPhaseName, getPhaseOf } from 'utils/time';

export type Mirror = {
  world: World;
  components: Components;
  blockNumber: number;
};

// ------------------------------------------------------- §3.12 enrichment
//
// The client-tooltip facts, served inline where a result names an item or a
// room without prose. Behind the daemon's `enrich` flag: every helper below
// is reached only from a `...(enrich ? … : {})` spread placed LAST in its
// object literal, so a flag-off answer is byte-identical to 0.3.0 (G3.g).
//
// SOURCES ARE CHAIN OR DEPLOYED CONFIG ONLY. Descriptions come from the
// mirror's Description components; effects from the item's own Allo
// registry; requirements from its Conditional registry; quest rewards from
// the reward Allos. No catalog, no authored document.

/** One interpreted line of an allo — upstream's own `DetailedEntity`,
 * projected to {name, description}. `image` is NEVER served: two shapes
 * files carry the module NAMESPACE of a png import there rather than a URL
 * (SPEC §4.1 quirk 2), so it is not a string at all. */
export type AlloText = { name: string; description: string };

/** One RAW allo with its interpreted text beside it, grouped per allo
 * deliberately: `parseAllo` fans out — a BONUS allo yields one entity per
 * bonus, a droptable allo yields one consolidated entity — so a flat parsed
 * list has no positional correspondence to the allos the world stores.
 * Grouping keeps type/index/value joined to the text upstream derives from
 * them and invents no pairing. */
export type AlloOut = {
  type: string;
  index: number;
  value: number;
  /** upstream's interpretation of this one allo; empty when this pin's
   * interpreter has none for the shape (the raw facts still stand) */
  entries: AlloText[];
};

export function toAlloOut(mirror: Mirror, allo: Allo): AlloOut {
  const { world, components } = mirror;
  let entries: AlloText[] = [];
  try {
    const parsed = parseAllo(world, components, allo);
    entries = (Array.isArray(parsed) ? parsed : [parsed])
      .filter((d) => d)
      .map((d) => ({ name: d.name ?? '', description: d.description ?? '' }));
  } catch {
    /* an allo shape this pin cannot interpret — serve the raw facts alone */
  }
  return {
    type: allo.type,
    index: Number(allo.index ?? 0),
    value: Number(allo.value ?? 0),
    entries,
  };
}

/** One USE requirement: the raw condition target plus upstream's own
 * interpreted text. Grouped rather than the flat `string[]` of
 * `Listing.requirements` because 48 of the 53 item conditions at this pin
 * are `KAMI_CAN_EAT` with index 0, whose text is the bare word "None" —
 * indistinguishable, without the target beside it, from a real requirement.
 * Text is verbatim including upstream's spacing quirks ("Is  DEAD "). */
/** §1.2 (verbatim values), corrected at 0.5.0: `value` is a STRING. A
 * condition's value is not always a count — a gate's is an entity id, and
 * `Number()` on an id-sized uint returns 2.65e+76, a number the world does
 * not hold and nothing can join on. Item conditions are index-shaped and
 * small at this pin, so the coercion was latent rather than wrong here; it
 * is still the same defect, and it is fixed in the same place the room-exit
 * shape fixed it. */
export type ItemRequirementOut = { type: string; index: number; value: string; text: string };

/** One condition the world stores, with the pinned client's own interpretation
 * of it beside the raw target. Shared by item USE requirements (0.4.0), room
 * exit gates and quest requirements (0.5.0) — one shape, because they are one
 * upstream type (`Conditional`) read through one upstream interpreter. */
export function toConditionOut(mirror: Mirror, con: Condition): ItemRequirementOut {
  const { world, components } = mirror;
  let text = '';
  try {
    text = parseConditionalText(world, components, con);
  } catch {
    text = con.target?.type ?? '';
  }
  return {
    type: con.target?.type ?? '',
    index: Number(con.target?.index ?? 0),
    // verbatim, never coerced — see the ItemRequirementOut note
    value: String(con.target?.value ?? 0),
    text,
  };
}

export function toItemRequirementOut(mirror: Mirror, con: Condition): ItemRequirementOut {
  return toConditionOut(mirror, con);
}

/** The three item facts an inventory row cannot answer "is this useful to
 * me?" without. All three are already computed by `getItem` on every read
 * and discarded at today's projections — this adds no mirror read. */
export type ItemEnrichment = {
  description: string;
  effects: { use: AlloOut[]; equip: AlloOut[] };
  requirements: ItemRequirementOut[];
};

export function itemEnrichment(mirror: Mirror, item: ShapeItem): ItemEnrichment {
  return {
    description: item.description ?? '',
    effects: {
      use: (item.effects?.use ?? []).map((a) => toAlloOut(mirror, a)),
      equip: (item.effects?.equip ?? []).map((a) => toAlloOut(mirror, a)),
    },
    requirements: (item.requirements?.use ?? []).map((c) => toItemRequirementOut(mirror, c)),
  };
}

/** Description only, for an item named in passing (a payment currency, an
 * auction lot, a trade order line) — identity, not a use decision. */
export function itemDescription(mirror: Mirror, index: number): { description: string } {
  try {
    const item = getItemByIndex(mirror.world, mirror.components, index);
    return { description: item?.description ?? '' };
  } catch {
    return { description: '' };
  }
}

/** A room named only by index, resolved to the name (and, where the answer
 * is the reader's own context rather than a history row, the description).
 * Unresolvable indices keep the index and answer with empty strings, the
 * same shape `roomRef` already uses for a room the mirror has no entity
 * for. */
export type RoomRefOut = { index: number; name: string; description?: string };

export function roomRefOut(mirror: Mirror, index: number, withDescription = true): RoomRefOut {
  let name = '';
  let description = '';
  try {
    const room = getRoomByIndex(mirror.world, mirror.components, index);
    name = room?.name ?? '';
    description = room?.description ?? '';
  } catch {
    /* a room index the mirror has no entity for */
  }
  return { index, name, ...(withDescription ? { description } : {}) };
}

// ------------------------------------------------- §3.13 payload economy (0.5.0)
//
// Listing answers serve a COMPACT default — id + name + the decision-relevant
// scalars, one row per entity, NO prose — and cap their row lists at LIST_CAP
// with the true total served beside the served count, so a truncated answer is
// never mistakable for a complete one. `--full` lifts the cap and restores
// every dropped field. Row order is deterministic and unconditional (§3.13):
// a capped answer whose membership depended on ECS iteration order would be a
// lottery, and a full answer that ordered differently from the capped one
// would make the two impossible to reconcile.

/** Default rows served by a capped listing. `--full` lifts it. */
export const LIST_CAP = 50;

/** Apply the cap. Returns the served slice plus the two counts every capped
 * listing carries. */
export function capRows<T>(rows: T[], full: boolean): { served: T[]; total: number } {
  return { served: full ? rows : rows.slice(0, LIST_CAP), total: rows.length };
}

// ------------------------------------------- §3.13 leveling loop (0.5.0)
//
// The whole loop, on the BASE surface. Every input below is already computed
// on the path that answers today and thrown away at the projection:
// KAMI_REFRESH forces `progress` and `skills` on every kami read (see the
// constant below and app/cache/kami/base.ts), so this adds no mirror read.
// The one addition is `calcExperienceRequirement`, a ported upstream function
// (network/shapes/Kami/progress.ts) the lens has never called — two config
// reads, measured at ~1.5 microseconds per call.

/** Why a kami that is not ready to level cannot level, in the pinned client's
 * own tooltip precedence (modals/kami/header/KamiImage.tsx: experience first,
 * then resting state). */
export type LevelUpBlocker = 'EXPERIENCE' | 'NOT_RESTING';

export type LevelingOut = {
  /** experience banked toward the next level */
  xp: number;
  /** what the next level costs, on the pinned client's own curve */
  xpRequired: number;
  /** BOTH conditions the chain requires: enough experience AND resting.
   * The reference client contains two contradictory renderings of this
   * (SPEC §4.2); the chain's own precondition wins. */
  levelUpReady: boolean;
  /** present exactly when levelUpReady is false */
  levelUpBlockedBy?: LevelUpBlocker;
  /** unspent skill points — the client's "SP" badge */
  skillPoints: number;
};

/** The leveling block for one already-projected kami. */
export function levelingOf(mirror: Mirror, kami: ReturnType<typeof getKami>): LevelingOut {
  const level = kami.progress?.level ?? 1;
  const xp = kami.progress?.experience ?? 0;
  const xpRequired = calcExperienceRequirement(mirror.world, mirror.components, level);
  const enough = xp >= xpRequired;
  const resting = isResting(kami);
  const levelUpReady = enough && resting;
  return {
    xp,
    xpRequired,
    levelUpReady,
    // tooltip precedence, verbatim: experience is reported first
    ...(levelUpReady ? {} : { levelUpBlockedBy: (!enough ? 'EXPERIENCE' : 'NOT_RESTING') as LevelUpBlocker }),
    skillPoints: kami.skills?.points ?? 0,
  };
}

/** One skill registry row, projected. Descriptions and bonus prose are
 * enrich-class (the same rung as item descriptions) and are NOT here. */
export type SkillRefOut = {
  index: number;
  name: string;
  type: string;
  tier: number;
  cost: number;
  max: number;
};

/** The skill registry, indexed. Built once per answer — 72 rows at this pin,
 * measured at 0.86 ms warm, against 0.08 ms for a single by-index read that
 * a per-kami join would pay once per investment. */
export function skillRegistryIndex(mirror: Mirror): Map<number, SkillRefOut> {
  const out = new Map<number, SkillRefOut>();
  for (const skill of getRegistrySkills(mirror.world, mirror.components)) {
    if (!skill.index) continue;
    out.set(skill.index, {
      index: skill.index,
      name: skill.name,
      type: skill.type,
      tier: skill.tier,
      cost: skill.cost,
      max: skill.max,
    });
  }
  return out;
}

export class QueryError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'BAD_ARGS'
      | 'KAMIDEN_UNAVAILABLE'
      | 'CHAT_DISABLED'
      /** §3.14: the kami config block is unusable, so any vitals computed
       * from it would be NaN. Refused rather than served. */
      | 'CONFIG_UNAVAILABLE'
      /** §3.14: a non-finite value reached the serialization boundary, where
       * JSON would have turned it into a plausible-looking `null`. */
      | 'NOT_FINITE',
    message: string
  ) {
    super(message);
  }
}

// ------------------------------------------------- §3.14 honest vitals (0.5.0)

/** Is this kami config block computable? A config that structured to NaN — an
 * unhydrated read — makes every value derived from it NaN, and JSON turns NaN
 * into `null`: an answer a reader cannot tell from a real zero. The daemon
 * refuses vitals until the block is real (SPEC §3.14, tripwire
 * `configUnavailable`). With the cache guards in place this should be
 * unreachable outside the first moments of a cold boot. */
export function assertKamiConfigUsable(kami: { config?: unknown }): void {
  const cfg = kami.config as
    | { harvest?: { intensity?: { nudge?: { value?: number } } } }
    | undefined;
  const probe = cfg?.harvest?.intensity?.nudge?.value;
  if (cfg === undefined || probe === undefined || !Number.isFinite(probe)) {
    tripwires.configUnavailable += 1;
    throw new QueryError(
      'CONFIG_UNAVAILABLE',
      'the kami config block has not hydrated: vitals would be computed from NaN and served as null. Retry once the daemon reports LIVE.'
    );
  }
}

// Force a full projection refresh on every read. The windows are staleness
// limits in seconds, compared with a strict `updateDelta > window`, so a
// window of 0 does NOT mean "always": two reads of the same kami inside the
// same millisecond give updateDelta === 0, the comparison is false, and the
// sub-object is skipped. That is harmless upstream, where the cache is
// never cleared and the sub-object is simply still there — but this layer
// clears the cache before each read to force freshness, and a cleared entry
// is rebuilt WITHOUT its optional sub-objects. The two together produced a
// kami with no stats at all, i.e. an answer reporting zero health for a
// healthy kami, whenever two queries touched the same kami in the same
// millisecond. -1 restores the intended meaning: refresh unconditionally.
// (Found by the 0.3 gate that asserts the compact roster and the party
// report agree — they disagreed, and the party report was the wrong one.)
const KAMI_REFRESH = {
  live: -1,
  base: -1,
  bonuses: -1,
  config: -1,
  flags: -1,
  harvest: -1,
  progress: -1,
  rerolls: -1,
  skills: -1,
  stats: -1,
  time: -1,
  traits: -1,
};

// ------------------------------------------- §3.16 the kami sheet (0.5.1)
//
// The stats/affinities half of the kami sheet, as an OPT-IN flag on the reads
// that already project a kami (`--stats`). Every input is ALREADY COMPUTED on
// the path that answers today and thrown away at the projection: KAMI_REFRESH
// forces `stats` and `traits` on every kami read (see the constant above and
// app/cache/kami/base.ts, which calls getKamiStats(..., true) — bonus
// included), so this adds no mirror read at all. The same shape the 0.5.0
// leveling loop had, and the same reason it was missing: nobody projected it.
//
// WITHOUT THE FLAG EVERY ANSWER IS BYTE-IDENTICAL TO 0.5.0. Each addition is
// reached only from a `...(withStats ? … : {})` spread placed LAST in its
// object literal — the §3.12 pattern, and what G3.g proves.

/** One stat, as the mirror decodes it (network/shapes/Stats.ts).
 *
 * `base`/`shift`/`boost`/`sync` are the four parts packed into the stat's
 * uint256 on chain; `total` is the client's own effective value,
 * `(1 + boost/1e3) × (base + shift)`, after skills and equipment — the
 * number the reference client renders on the kami sheet.
 *
 * NAMED `total`, NOT `current`, DELIBERATELY. This answer already carries
 * `hp.current` (calcHealth — the drained/regenerated live health) beside
 * `hp.total`. A second field called "current health" holding the stat
 * maximum would put two different numbers under one word in one answer, and
 * `total` is the ported field's own name besides.
 *
 * NO `rate` FIELD. `Stat.rate` is written by updateHealthRate and by nothing
 * else, so it is structurally 0 for power, harmony and violence — a
 * lie-shaped zero (§3.14). Health's rate is already served, as
 * `hpRatePerHr`.
 *
 * `shift` INCLUDES THE BONUS. The mirror's getStats is called with
 * withBonus=true, so a STAT_*_SHIFT bonus from a skill or an equipped item is
 * folded in here, while the chain's stored component value does not carry it.
 * G2.d records both numbers per kami; if any live kami is ever found where
 * they diverge, this shape gains an explicit `shiftBonus` and the gate
 * asserts shift === chainShift + shiftBonus. */
export type StatOut = {
  base: number;
  shift: number;
  boost: number;
  sync: number;
  total: number;
};

/** The four stats the chain's own GetterSystem.getKamiByIndex tuple carries,
 * and therefore the four this surface can be held to. `slots` is in the
 * mirror's KamiStats and `stamina` in the generic Stats shape; neither is in
 * the getter's KamiShape, so serving them would put numbers on the surface
 * that no gate could check against chain. */
export type KamiStatsOut = {
  health: StatOut;
  power: StatOut;
  harmony: StatOut;
  violence: StatOut;
};

/** The kami sheet's stat block plus its affinity pair, for one already-
 * projected kami. Returns undefined when the projection has no stats at all —
 * assertKamiConfigUsable already refuses that case upstream of every caller,
 * so this is belt-and-braces rather than a live path, and an ABSENT block is
 * the honest answer where a zeroed one would lie (§3.14). */
export function statsOf(kami: ReturnType<typeof getKami>):
  | { stats: KamiStatsOut; affinities: string[] }
  | undefined {
  const s = kami.stats;
  if (!s) return undefined;
  const one = (st: { base: number; shift: number; boost: number; sync: number; total: number }): StatOut => ({
    base: st.base,
    shift: st.shift,
    boost: st.boost,
    sync: st.sync,
    total: st.total,
  });
  return {
    stats: {
      health: one(s.health),
      power: one(s.power),
      harmony: one(s.harmony),
      violence: one(s.violence),
    },
    // [body, hand] — the reference client's own pair and its own defaulting
    // (app/cache/kami/functions.ts: 'NORMAL' when the trait carries none)
    affinities: [getKamiBodyAffinity(kami), getKamiHandAffinity(kami)],
  };
}

// ---------------------------------------------------------------- kami

export type KamiVitals = {
  id: string;
  index: number;
  name: string;
  state: string;
  level?: number;
  /** §3.13 (0.5.0): the whole leveling loop, base surface. `level` alone
   * answered "how far along" and nothing a reader could act on: the banked
   * experience, what the next level costs, whether it can be taken right now
   * and why not, and the unspent skill points were all computed on this very
   * path and discarded. Flat rather than nested so `level` keeps its place
   * and nothing moved or was renamed. */
  xp?: number;
  xpRequired?: number;
  levelUpReady?: boolean;
  levelUpBlockedBy?: LevelUpBlocker;
  skillPoints?: number;
  hp: { current: number; total: number; percent: number };
  hpRatePerHr: string;
  musu?: { accrued: number; spotRatePerHr: string; avgRatePerHr: string };
  cooldownSec: number;
  node?: { index: number; name: string };
  account?: { index: number; name: string };
  /** §3.16 (0.5.1): `--stats` only. Absent without the flag. */
  stats?: KamiStatsOut;
  /** §3.16 (0.5.1): `--stats` only — [body, hand]. Absent without the flag. */
  affinities?: string[];
};

export function buildKamiVitals(
  mirror: Mirror,
  entity: EntityIndex,
  withStats = false
): KamiVitals {
  const { world, components } = mirror;
  KamiCache.clear();
  const kami = getKami(world, components, entity, KAMI_REFRESH);
  assertKamiConfigUsable(kami);
  const hp = calcHealth(kami);
  const total = kami.stats?.health.total ?? 0;
  const owner = getKamiAccount(world, components, entity);
  const leveling = levelingOf(mirror, kami);
  const vitals: KamiVitals = {
    id: kami.id,
    index: kami.index,
    name: kami.name,
    state: kami.state,
    level: kami.progress?.level,
    ...leveling,
    hp: { current: hp, total, percent: Number(calcHealthPercent(kami).toFixed(0)) },
    hpRatePerHr: getRateDisplay(kami.stats?.health.rate, 2),
    cooldownSec: Math.max(0, Math.floor(calcCooldown(kami))),
    account: owner.index ? { index: owner.index, name: owner.name } : undefined,
  };
  if (kami.harvest && kami.harvest.state === 'ACTIVE') {
    vitals.musu = {
      accrued: calcOutput(kami),
      spotRatePerHr: getRateDisplay(kami.harvest.rates.total.spot, 2),
      avgRatePerHr: getRateDisplay(kami.harvest.rates.total.average, 2),
    };
    const node = kami.harvest.node;
    if (node) vitals.node = { index: node.index, name: node.name };
  }
  // §3.16: LAST, and only behind the flag — a flag-off answer keeps its exact
  // 0.5.0 key set and key ORDER (G3.g compares both)
  if (withStats) {
    const sheet = statsOf(kami);
    if (sheet) {
      vitals.stats = sheet.stats;
      vitals.affinities = sheet.affinities;
    }
  }
  return vitals;
}

export function kamiQuery(
  mirror: Mirror,
  args: { index: number; stats?: boolean }
): KamiVitals {
  const entity = queryKamiByIndex(mirror.world, mirror.components, args.index);
  if (entity === undefined) throw new QueryError('NOT_FOUND', `kami ${args.index} not in mirror`);
  return buildKamiVitals(mirror, entity, args.stats === true);
}

// ------------------------------------------------------------- account

export type AccountOut = {
  id: string;
  index: number;
  name: string;
  ownerAddress: string;
  operatorAddress: string;
  roomIndex: number;
  musu: number;
  /** current = calcCurrentStamina (recovery-adjusted, CLAMPED to total — the
   * SPENDABLE figure); total = the stat's computed cap (0.2.0); raw = the
   * same accrual without the clamp (0.5.0).
   *
   * §4.2, and read the direction carefully. The chain's *view* getter
   * `LibAccount.getCurrentStamina` returns `sync + recovered` unclamped, and
   * that is the number its error text quotes — which is why one arm saw
   * "209–212" beside a served `100/100` and stopped trusting the maximum. But
   * the chain CLAMPS on the write path: `LibStat.calcSync` caps at the total,
   * and a spend is synced before it is charged. So `current` is the honest
   * budget and `raw` is NOT spendable. It is served to explain the
   * discrepancy — an unexplained mismatch is what made the arm distrust a
   * correct answer — and never as a spending allowance. */
  stamina: { current: number; total: number; raw: number };
  reputation: { agency: number; mina: number; nursery: number };
  kamis: { id: string; index: number; name: string; state: string }[];
  bio?: string;
  /** §3.12 (enrich): `roomIndex` resolved — where the account is standing,
   * by name and description rather than by bare index */
  room?: RoomRefOut;
  /** §3.13 (0.5.0): the account's own gas position — the one balance that
   * decides whether it can act at all, and the only fact on this surface read
   * from the chain rather than from the mirror. ABSENT, never faked, when the
   * RPC read fails: the mirror answer is never blocked on it, and the RPC's
   * health is reported in `status` the same way a Kamiden feed's is. */
  gas?: GasOut;
};

export type GasBalanceOut = {
  address: string;
  /** wei, as a DECIMAL STRING: the value does not fit a JSON number */
  wei: string;
  /** the same value in ETH — a unit conversion, not a game formula */
  eth: number;
};

export type GasOut = {
  /** the signer that pays for every act */
  operator: GasBalanceOut;
  owner: GasBalanceOut;
  /** the CHAIN block these balances were read at. Deliberately separate from
   * `meta.blockNumber`, which is the mirror's block: the two clocks differ,
   * and hiding that would make a skew invisible rather than absent. */
  blockNumber: number;
};

/** How far behind reported head the balance read is pinned.
 *
 * The public endpoint is load-balanced, and the node that answers
 * `eth_getBalance` is not always the node that answered `eth_blockNumber` a
 * moment earlier: reading at the exact head returns "requested height is
 * greater than the latest block height" whenever the second node is a block
 * or two behind. A few blocks of lag costs nothing — the mirror this answer
 * is served beside can be hundreds of thousands of blocks older — and the
 * block actually used is reported, so the reader is never guessing. */
const GAS_BLOCK_LAG = 4;

/** Read native balances for both of an account's addresses at one pinned
 * block. Returns undefined on any failure — the caller omits the block. */
export async function gasOf(
  rpc: NativeBalanceReader,
  operatorAddress: string,
  ownerAddress: string
): Promise<GasOut | undefined> {
  try {
    const head = await rpc.blockNumber();
    const blockNumber = Math.max(0, head - GAS_BLOCK_LAG);
    const [operator, owner] = await Promise.all([
      rpc.nativeBalance(operatorAddress, blockNumber),
      rpc.nativeBalance(ownerAddress, blockNumber),
    ]);
    const at = (address: string, wei: bigint): GasBalanceOut => ({
      address,
      wei: wei.toString(),
      eth: Number(wei) / 1e18,
    });
    return {
      operator: at(operatorAddress, operator),
      owner: at(ownerAddress, owner),
      blockNumber,
    };
  } catch {
    // never block the mirror answer on an RPC that did not answer
    return undefined;
  }
}

/** What a query needs from the chain to serve a native balance. Kept to this
 * shape so the query layer never holds a provider of its own (§3.6). */
export type NativeBalanceReader = {
  blockNumber: () => Promise<number>;
  nativeBalance: (address: string, blockTag: number) => Promise<bigint>;
};

export async function accountQuery(
  mirror: Mirror,
  args: { index?: number; name?: string; address?: string },
  opts: { prose?: boolean } = {},
  enrich = false,
  rpc?: NativeBalanceReader
): Promise<AccountOut> {
  const { world, components } = mirror;
  // config: calcCurrentStamina reads config.stamina.recovery (the Clock
  // fixture fetches the account the same way)
  const options = { kamis: true, config: true, ...(opts.prose ? { bio: true } : {}) };
  // §3.14: an ADDRESS is a third lookup key. An account holds two of them and
  // a caller rarely knows which it has, so both are tried — owner first, then
  // operator. Added because a real reader tried exactly this and got
  // NOT_FOUND: the address went down the NAME path, matched nothing, and the
  // answer was indistinguishable from "no such account".
  const byAddress = (): ReturnType<typeof getAccountByOwner> | undefined => {
    const owned = getAccountByOwner(world, components, args.address!, options);
    if (owned.index) return owned;
    const operated = getAccountByOperator(world, components, args.address!, options);
    return operated.index ? operated : owned;
  };
  const account =
    args.index !== undefined
      ? getAccountByIndex(world, components, args.index, options)
      : args.name !== undefined
        ? getAccountByName(world, components, args.name, options)
        : args.address !== undefined
          ? byAddress()
          : undefined;
  if (!account) throw new QueryError('BAD_ARGS', 'account query needs an index, a name or an address');
  if (!account.index) {
    throw new QueryError(
      'NOT_FOUND',
      `account ${args.index ?? args.name ?? args.address} not in mirror`
    );
  }
  const gas = rpc
    ? await gasOf(rpc, account.operatorAddress, account.ownerAddress)
    : undefined;
  return {
    id: account.id,
    index: account.index,
    name: account.name,
    ownerAddress: account.ownerAddress,
    operatorAddress: account.operatorAddress,
    roomIndex: account.roomIndex,
    musu: account.coin,
    stamina: {
      current: calcCurrentStamina(account),
      total: account.stamina.total,
      raw: rawStamina(account),
    },
    reputation: account.reputation,
    kamis: (account.kamis ?? []).map((k) => ({
      id: k.id,
      index: k.index,
      name: k.name,
      state: k.state,
    })),
    ...(opts.prose && account.bio !== undefined ? { bio: account.bio } : {}),
    ...(enrich ? { room: roomRefOut(mirror, account.roomIndex) } : {}),
    ...(gas ? { gas } : {}),
  };
}

/** The account's stamina accrual with NO clamp — the same quantity the
 * chain's VIEW getter returns, and the one its error strings quote (§4.2).
 * Not a spendable budget: the chain caps at `total` when it syncs before a
 * charge. Computed here, in native query code, rather than by touching the
 * ported `calcCurrentStamina` — the clamp is the client's behaviour and
 * parity with it is not a defect to fix. */
function rawStamina(account: {
  config?: { stamina?: { recovery?: number } };
  time: { action: number };
  stamina: { sync: number };
}): number {
  if (!account.config) return account.stamina.sync;
  const recoveryPeriod = account.config.stamina?.recovery ?? 60;
  const timeDelta = clock.now() / 1000 - account.time.action;
  const recovered = Math.floor(timeDelta / recoveryPeriod);
  return Math.max(0, account.stamina.sync + recovered);
}

// ---------------------------------------------------------------- node

export type HarvestVitals = {
  hp: { current: number; total: number; percent: number };
  /** `--full` only from 0.5.0 (§3.13) */
  hpRatePerHr?: string;
  /** calcOutput — the realizable MUSU at stake in this harvest */
  musuAccrued: number;
  cooldownSec: number;
  /** §3.13 (0.5.0): the occupant's level and leveling state. This is the
   * surface a liquidation decision is actually made on, and it served health
   * without ever naming how strong the thing holding it was. */
  level?: number;
  xp?: number;
  xpRequired?: number;
  levelUpReady?: boolean;
  levelUpBlockedBy?: LevelUpBlocker;
  skillPoints?: number;
  /** §3.16 (0.5.1): `--stats` only. The threat read is exactly where the
   * occupant's stats belong — power and violence decide what it can do back. */
  stats?: KamiStatsOut;
  /** §3.16 (0.5.1): `--stats` only — [body, hand]. The liquidation calcs
   * upstream turn on this pair (calcs/liquidation.ts), so a reader previewing
   * a liquidation could not check the preview's own inputs without it. */
  affinities?: string[];
};

/** Why a liquidation the preview reports as ineligible is ineligible.
 * Upstream's own precedence, from the reference client's LiquidateButton
 * tooltip (app/components/library/buttons/actions/LiquidateButton.tsx,
 * getLiquidateTooltip): starving first, then cooldown, then the threshold
 * comparison — with the degenerate "no threshold at all" case called out
 * separately, exactly as that tooltip does. The client's fifth branch
 * ("your kamis aren't on this node") has no analogue here: the attacker is
 * a general argument on this surface, never an own-only path (§3.6). */
export type LiquidationBlocker =
  | 'ATTACKER_STARVING'
  | 'ATTACKER_COOLDOWN'
  | 'TARGET_HP_ABOVE_THRESHOLD'
  | 'THRESHOLD_ZERO';

export type LiquidationPreview = {
  /** canLiquidate(attacker, occupant) — cooldown/starving gates included */
  eligible: boolean;
  /** §3.13 (0.5.0): present exactly when `eligible` is false. The flag was
   * right but opaque, and a reader that cannot tell "my kami is on cooldown"
   * from "this target is out of reach" cannot act on either. */
  reason?: LiquidationBlocker;
  /** HP cutoff: attacker can liquidate while occupant HP is below this */
  threshold: number;
  spoils: number;
  salvage: number;
  recoil: number;
};

/** The reason `canLiquidate` said no, evaluated on the same predicate parts
 * it is built from (`!onCooldown(attacker) && !isStarving(attacker) &&
 * canMog(attacker, defender)`), reported in the client tooltip's order. */
export function liquidationBlocker(
  attacker: ReturnType<typeof getKami>,
  threshold: number
): LiquidationBlocker {
  if (isStarving(attacker)) return 'ATTACKER_STARVING';
  if (onCooldown(attacker)) return 'ATTACKER_COOLDOWN';
  return threshold <= 0 ? 'THRESHOLD_ZERO' : 'TARGET_HP_ABOVE_THRESHOLD';
}

export type NodeOut = {
  index: number;
  name: string;
  type: string;
  affinity: string[];
  roomIndex: number;
  /** compacted away by default (§3.13); `--full` restores it */
  description?: string;
  /** §3.12 (enrich): `roomIndex` resolved — the room this node sits in */
  room?: RoomRefOut;
  /** echoed with the attacker-kami argument (vitals mode only) */
  attacker?: { id: string; index: number; name: string; cooldownSec: number };
  harvestsTotal: number;
  harvestsServed: number;
  harvests: {
    /** `--full` only */
    id?: string;
    state: string;
    kami: { id?: string; index: number; name?: string };
    account: { index: number; name?: string };
    vitals?: HarvestVitals;
    liquidation?: LiquidationPreview;
  }[];
};

/** Node occupancy (identity-only by default — the 0.1.0 shape, unchanged).
 * withVitals adds per-occupant computed vitals through the same forced-
 * refresh cache path buildKamiVitals uses. An attacker kami index (any
 * kami — a general argument, never an own-only path) additionally previews
 * the liquidation pairing the client's LiquidateButton computes per
 * (attacker, occupant): canLiquidate, threshold, spoils/salvage, recoil.
 * The attacker's own harvest row carries no liquidation block (a kami is
 * not its own target). */
export function nodeQuery(
  mirror: Mirror,
  args: {
    index: number;
    withVitals?: boolean;
    attacker?: number;
    full?: boolean;
    stats?: boolean;
  },
  enrich = false
): NodeOut {
  const { world, components } = mirror;
  const full = args.full === true;
  const node = getNodeByIndex(world, components, args.index);
  if (!node || !node.index) {
    throw new QueryError('NOT_FOUND', `node ${args.index} not in mirror`);
  }
  const nodeEntity = queryNodeEntityByIndex(world, args.index);
  const harvestEntities = queryHarvests(world, components, nodeEntity);
  if (args.withVitals) KamiCache.clear();

  let attackerOut: NodeOut['attacker'];
  let attackerKami: ReturnType<typeof getKami> | undefined;
  if (args.withVitals && args.attacker !== undefined) {
    const entity = queryKamiByIndex(world, components, args.attacker);
    if (entity === undefined) {
      throw new QueryError('NOT_FOUND', `attacker kami ${args.attacker} not in mirror`);
    }
    attackerKami = getKami(world, components, entity, KAMI_REFRESH);
    attackerOut = {
      id: attackerKami.id,
      index: attackerKami.index,
      name: attackerKami.name,
      cooldownSec: Math.max(0, Math.floor(calcCooldown(attackerKami))),
    };
  }

  const rows = harvestEntities.map((h) => {
    const harvest = getHarvest(world, components, h);
    const kami = getHarvestKami(world, components, h);
    const owner = kami ? getKamiAccount(world, components, kami.entity) : undefined;
    const row: NodeOut['harvests'][number] = {
      ...(full ? { id: harvest.id } : {}),
      state: harvest.state,
      kami: kami
        ? { ...(full ? { id: kami.id, name: kami.name } : {}), index: kami.index }
        : { ...(full ? { id: '0x0', name: '' } : {}), index: 0 },
      account: owner?.index
        ? { index: owner.index, ...(full ? { name: owner.name } : {}) }
        : { index: 0, ...(full ? { name: '' } : {}) },
    };
    if (args.withVitals && kami) {
      const occupant = getKami(world, components, kami.entity, KAMI_REFRESH);
      assertKamiConfigUsable(occupant);
      const hp = calcHealth(occupant);
      const leveling = levelingOf(mirror, occupant);
      row.vitals = {
        hp: {
          current: hp,
          total: occupant.stats?.health.total ?? 0,
          percent: Number(calcHealthPercent(occupant).toFixed(0)),
        },
        ...(full ? { hpRatePerHr: getRateDisplay(occupant.stats?.health.rate, 2) } : {}),
        musuAccrued: calcOutput(occupant),
        cooldownSec: Math.max(0, Math.floor(calcCooldown(occupant))),
        // §3.13: the threat read needs to know how strong the occupant is
        level: occupant.progress?.level,
        ...leveling,
      };
      // §3.16: LAST on the vitals object, behind the flag
      if (args.stats) {
        const sheet = statsOf(occupant);
        if (sheet) {
          row.vitals.stats = sheet.stats;
          row.vitals.affinities = sheet.affinities;
        }
      }
      if (attackerKami && occupant.id !== attackerKami.id) {
        const eligible = canLiquidate(attackerKami, occupant);
        const threshold = calcLiqThreshold(attackerKami, occupant);
        row.liquidation = {
          eligible,
          ...(eligible ? {} : { reason: liquidationBlocker(attackerKami, threshold) }),
          threshold,
          spoils: calcLiqSpoils(attackerKami, occupant),
          salvage: calcLiqSalvage(occupant),
          recoil: calcLiqRecoil(attackerKami, occupant),
        };
      }
    }
    return row;
  });
  // deterministic order: by kami index, so a capped answer and a --full
  // answer agree about which rows come first (§3.13)
  rows.sort((a, b) => a.kami.index - b.kami.index);
  const { served, total } = capRows(rows, full);
  return {
    index: node.index,
    name: node.name,
    type: node.type,
    affinity: Array.isArray(node.affinity) ? node.affinity : [node.affinity].filter(Boolean),
    roomIndex: node.roomIndex,
    ...(full ? { description: node.description ?? '' } : {}),
    ...(enrich ? { room: roomRefOut(mirror, node.roomIndex) } : {}),
    ...(attackerOut ? { attacker: attackerOut } : {}),
    harvestsTotal: total,
    harvestsServed: served.length,
    harvests: served,
  };
}

// --------------------------------------------------------------- party

export type PartyOut = {
  account: { index: number; name: string };
  /** §3.13 (0.5.0): every kami the account owns, whether or not this answer
   * served it. A truncated list is never mistakable for a complete one. */
  kamisTotal: number;
  kamisServed: number;
  kamis: KamiVitals[];
};

/** Account party report. Rows keep FULL vitals — the party query is the
 * detail surface and compacting its rows is what `roster` is for — but the
 * LIST is capped (§3.13): the largest roster in the world runs to four
 * figures, and an uncapped answer measured 281 KB against a reader's 64 KB
 * context. Rows are ordered by kami index, unconditionally, so the capped
 * answer and the `--full` answer agree about which rows come first. */
export function partyQuery(
  mirror: Mirror,
  args: { accountIndex: number; full?: boolean; stats?: boolean }
): PartyOut {
  const { world, components } = mirror;
  const account = getAccountByIndex(world, components, args.accountIndex, { kamis: true });
  if (!account.index) {
    throw new QueryError('NOT_FOUND', `account ${args.accountIndex} not in mirror`);
  }
  const all = (account.kamis ?? [])
    .map((k) => buildKamiVitals(mirror, k.entity, args.stats === true))
    .sort((a, b) => a.index - b.index);
  const { served, total } = capRows(all, args.full === true);
  return {
    account: { index: account.index, name: account.name },
    kamisTotal: total,
    kamisServed: served.length,
    kamis: served,
  };
}

// --------------------------------------------------------------- roster

export type RosterOut = {
  /** no account name: the roster is deliberately name-free (see below).
   * §3.12 (enrich) adds `room` — {index, name} only, NO description: the
   * addition is fixed overhead (+46 bytes measured), so the compaction
   * property is untouched, and a room NAME is `registry` class, not
   * authored, so the empty-untrusted-list and name-free byte-identity
   * guarantees hold in enriched mode too.
   *
   * §3.13 (0.5.0) adds the two CHEAP leveling signals as SETS on the account
   * block rather than as fields on the kami rows. That placement is the whole
   * point: the roster's compaction guarantee is measured as marginal bytes
   * PER KAMI (G7.a), and anything outside `kamis[]` cancels out of that
   * measurement — so the marginal cost stays exactly what it was, at every
   * roster composition, including the worst case where every kami appears in
   * both sets. Measured on the largest roster in the fixture (1,050 kamis):
   * per-row fields would have cost 62.75 B/kami, ratio 0.234 against the
   * frozen 0.25 and 0.310 in the worst case — a threshold pass by luck of
   * composition. The set form measures 46.86 B/kami, ratio 0.175, unchanged
   * from 0.4.0 and unchanged in the worst case. Both are numeric, so the
   * empty-untrusted-list and name-free guarantees are untouched: skill NAMES
   * never appear here. */
  account: {
    index: number;
    roomIndex: number;
    room?: RoomRefOut;
    /** kami indices that can be levelled up RIGHT NOW (enough experience and
     * resting — both conditions the chain requires) */
    levelUpReady: number[];
    /** [kamiIndex, unspentSkillPoints] for every kami holding any */
    skillPoints: number[][];
  };
  kamis: {
    index: number;
    state: string;
    hp: number[];
    /** §3.16 (0.5.1): `--stats` only. Absent without the flag. */
    stats?: KamiStatsOut;
    /** §3.16 (0.5.1): `--stats` only — [body, hand]. Absent without the flag. */
    affinities?: string[];
  }[];
  /** §3.16 (0.5.1): present ONLY under `--stats`, which caps this list.
   * The flag-off roster is uncapped and carries neither count — see the
   * note on rosterQuery for why the cap arrives with the flag and not
   * before it. */
  kamisTotal?: number;
  kamisServed?: number;
};

/** Compact roster (0.3.0): one line per kami — index, state, [hp, hpTotal] —
 * plus where the account itself is standing. Sized to stay readable at
 * large rosters where the full party report does not; full detail (names,
 * rates, accrued MUSU, cooldowns, node) stays on the party query, which is
 * unchanged.
 *
 * PROPERTY WORTH RELYING ON: this answer carries no authored strings at
 * all — no kami names, no account name — so its untrusted list is always
 * empty and it is identical in name-free mode. Identities are indices,
 * which is what a consumer joins on anyway.
 *
 * Compaction is a payload property, not a latency one: every row goes
 * through the SAME per-kami projection the party report uses, and is then
 * projected down. That is deliberate — computing the compact rows by a
 * cheaper path of their own would let the two answers drift apart, and a
 * roster that disagrees with the party report about a kami's health is
 * worse than no roster. (It did, in the first run of the gate that now
 * asserts the agreement: the projection cache is shared, and refreshing it
 * once per answer rather than once per kami produced different health than
 * the party report for the same kami at the same block.) */
export function rosterQuery(
  mirror: Mirror,
  args: { accountIndex: number; stats?: boolean },
  enrich = false
): RosterOut {
  const { world, components } = mirror;
  const account = getAccountByIndex(world, components, args.accountIndex, { kamis: true });
  if (!account.index) {
    throw new QueryError('NOT_FOUND', `account ${args.accountIndex} not in mirror`);
  }
  const withStats = args.stats === true;
  const levelUpReady: number[] = [];
  const skillPoints: number[][] = [];
  const kamis = (account.kamis ?? []).map((k) => {
    const vitals = buildKamiVitals(mirror, k.entity, withStats);
    if (vitals.levelUpReady) levelUpReady.push(vitals.index);
    if (vitals.skillPoints) skillPoints.push([vitals.index, vitals.skillPoints]);
    return {
      index: vitals.index,
      state: vitals.state,
      hp: [vitals.hp.current, vitals.hp.total],
      // §3.16: LAST on the row, behind the flag
      ...(withStats && vitals.stats
        ? { stats: vitals.stats, affinities: vitals.affinities }
        : {}),
    };
  });
  // §3.16 + §3.13 ("a cap is honest or it is a lie"): the roster is the one
  // listing with no cap, and it can afford not to have one — a row is ~53
  // bytes. A `--stats` row is ~346, and the largest roster in the world runs
  // to four figures: measured, `roster --stats` over 1,050 kamis projects to
  // ~363 KB against a 64 KiB reader. So the FLAG brings the standard cap with
  // it, with the true total beside the served count, rather than serving a
  // list nobody can read or truncating one silently. Flag-off keeps the
  // uncapped shape it has always had, counts included — adding them
  // unconditionally would have been a default-answer change (G3.g).
  //
  // The account-block SETS stay complete either way: they are account-level
  // facts, not row fields, and capping them would lose information the
  // flag-off answer had.
  //
  // ORDER BECOMES LOAD-BEARING THE MOMENT THE LIST IS CAPPED. The flag-off
  // roster is uncapped, so it has always been free to serve rows in the
  // mirror's own iteration order — nothing is lost, and a consumer joins on
  // the index anyway. A CAPPED list in that order is the lottery §3.13
  // refuses: which fifty kamis you get would depend on an incidental query
  // order, and two answers could not be reconciled. So the `--stats` path
  // sorts by kami index before capping, exactly as `party` and `node` do.
  // Flag-off is deliberately NOT sorted, because sorting it would change a
  // default answer (G3.g) for no gain on an uncapped list.
  const capped = withStats
    ? capRows([...kamis].sort((a, b) => a.index - b.index), false)
    : null;
  return {
    account: {
      index: account.index,
      roomIndex: account.roomIndex,
      // {index, name} only — see the RosterOut note
      ...(enrich ? { room: roomRefOut(mirror, account.roomIndex, false) } : {}),
      // §3.13: SETS, not row fields — see the RosterOut note
      levelUpReady,
      skillPoints,
    },
    kamis: capped ? capped.served : kamis,
    ...(capped ? { kamisTotal: capped.total, kamisServed: capped.served.length } : {}),
  };
}

// -------------------------------------------------------------- skills

export type SkillsOut = {
  /** how many skills the registry holds, whichever form was asked for */
  skillsTotal: number;
  /** the registry, when no kami was named */
  skills?: (SkillRefOut & { description?: string; bonuses?: BonusOut[] })[];
  /** the kami's own state, when one was named */
  kami?: { index: number };
  /** unspent skill points — the client's "SP" badge */
  unspent?: number;
  /** taken skills with their ranks; empty when the kami has spent nothing */
  invested?: (SkillRefOut & { points: number; description?: string })[];
};

/** Skills (0.5.0, §3.13). Without an argument: the skill registry — what
 * exists, what tree and tier it sits in, what it costs and how far it can be
 * taken. With a kami index: that kami's unspent points and the skills it has
 * actually taken, with ranks.
 *
 * Skill DESCRIPTIONS and interpreted bonus text are enrich-class, the same
 * rung as item descriptions (§3.12): the decision "do I have points to spend
 * and where have I spent them" needs neither. */
export function skillsQuery(
  mirror: Mirror,
  args: { kamiIndex?: number },
  enrich = false
): SkillsOut {
  const { world, components } = mirror;
  const registry = skillRegistryIndex(mirror);
  if (args.kamiIndex === undefined) {
    const skills = [...registry.values()]
      .sort((a, b) => a.index - b.index)
      .map((row) => ({
        ...row,
        ...(enrich ? skillEnrichment(mirror, row.index) : {}),
      }));
    return { skillsTotal: registry.size, skills };
  }
  const entity = queryKamiByIndex(world, components, args.kamiIndex);
  if (entity === undefined) {
    throw new QueryError('NOT_FOUND', `kami ${args.kamiIndex} not in mirror`);
  }
  KamiCache.clear();
  const kami = getKami(world, components, entity, KAMI_REFRESH);
  const invested = (kami.skills?.investments ?? [])
    .filter((i) => i.index)
    .sort((a, b) => a.index - b.index)
    .map((i) => {
      const row = registry.get(i.index);
      return {
        index: i.index,
        name: row?.name ?? '',
        type: row?.type ?? '',
        tier: row?.tier ?? 0,
        cost: row?.cost ?? 0,
        max: row?.max ?? 0,
        points: i.points,
        ...(enrich ? { description: skillEnrichment(mirror, i.index).description } : {}),
      };
    });
  return {
    skillsTotal: registry.size,
    kami: { index: kami.index },
    unspent: kami.skills?.points ?? 0,
    invested,
  };
}

/** One bonus a skill grants: the RAW facts the world stores beside the pinned
 * client's own rendering of them (`parseBonusText`), the same shape discipline
 * §3.12 applies to allocations — serve the facts, never invent the formula. */
export type BonusOut = {
  type: string;
  value: number;
  endType?: string;
  duration?: number;
  text: string;
};

/** §3.12-class enrichment for one skill: the registry description and the
 * bonuses it grants, raw facts plus the pin's own text. */
function skillEnrichment(
  mirror: Mirror,
  index: number
): { description: string; bonuses: BonusOut[] } {
  try {
    const skill = getSkillByIndex(mirror.world, mirror.components, index);
    const bonuses = (skill?.bonuses ?? []).map((b) => {
      let text = '';
      try {
        text = parseBonusText(b);
      } catch {
        text = b.type ?? '';
      }
      return {
        type: b.type ?? '',
        value: Number(b.value ?? 0),
        ...(b.endType !== undefined ? { endType: b.endType } : {}),
        ...(b.duration !== undefined ? { duration: Number(b.duration) } : {}),
        text,
      };
    });
    return { description: skill?.description ?? '', bonuses };
  } catch {
    return { description: '', bonuses: [] };
  }
}

// ---------------------------------------------------------------- item

export type ItemOut = {
  /** `--full` only from 0.5.0 (§3.13) */
  id?: string;
  index: number;
  name: string;
  type: string;
  /** `--full` only from 0.5.0 (§3.13): 18.9 KB of the item registry's 50 KB
   * is description prose, identical on every call */
  description?: string;
  /** who the item is FOR — KAMI vs ACCOUNT. The single fact that tells a
   * kami food from an account food when both read `type: FOOD`. */
  for?: string;
  rarity: number;
  /** pools trading this item (0.3.0); present on the single-item answer,
   * an empty array when the item trades in none */
  pools?: PoolOut[];
  /** §3.12 (enrich): what USE and EQUIP do, one row per raw allo */
  effects?: { use: AlloOut[]; equip: AlloOut[] };
  /** §3.12 (enrich): what USE requires, raw target + interpreted text */
  requirements?: ItemRequirementOut[];
  /** §3.12 (enrich): registry flags the world stores on the item */
  is?: { tradeable: boolean; disabled: boolean };
};

function toItemOut(
  item: {
    id: string;
    index: number;
    name: string;
    type: string;
    description?: string;
    for?: string;
    rarity?: number;
  },
  full = false
): ItemOut {
  return {
    ...(full ? { id: item.id } : {}),
    index: item.index,
    name: item.name,
    type: item.type,
    ...(full ? { description: item.description ?? '' } : {}),
    // omitted rather than served as '' when the world holds no target: an
    // empty string reads as a fact, and 77 of 177 items genuinely have none
    ...(item.for ? { for: item.for } : {}),
    rarity: item.rarity ?? 0,
  };
}

/** §3.12: the registry facts `getItem` already computed and `toItemOut`
 * discarded — effects, USE requirements, and the two stored flags. */
function itemRegistryEnrichment(
  mirror: Mirror,
  item: ShapeItem
): Pick<ItemOut, 'effects' | 'requirements' | 'is'> {
  const { effects, requirements } = itemEnrichment(mirror, item);
  return {
    effects,
    requirements,
    is: { tradeable: item.is?.tradeable ?? false, disabled: item.is?.disabled ?? false },
  };
}

/** A single item is a KEYED answer, never a listing: it always serves the
 * full row, description included. Keyed detail is what a compact listing
 * points at (§3.13). */
export function itemQuery(mirror: Mirror, args: { index: number }, enrich = false): ItemOut {
  const item = getItemByIndex(mirror.world, mirror.components, args.index);
  if (!item || !item.index) throw new QueryError('NOT_FOUND', `item ${args.index} not in mirror`);
  const pools = poolsQuery(mirror).filter((p) => p.items.includes(args.index));
  return {
    ...toItemOut(item, true),
    pools,
    ...(enrich ? itemRegistryEnrichment(mirror, item) : {}),
  };
}

export type ItemsOut = { itemsTotal: number; items: ItemOut[]; pools: PoolOut[] };

/** The item registry. Compact by default (§3.13): index, name, type, target
 * and rarity — no id, no description. `[type]` filters to one item type,
 * which is the natural question ("what food can I buy"); `--full` restores
 * the whole row. The registry is NOT capped: it is bounded by the world's own
 * content and the compact form measures 16 KB against a 64 KB reader. */
export function itemsQuery(
  mirror: Mirror,
  args: { type?: string; full?: boolean } = {},
  enrich = false
): ItemsOut {
  const full = args.full === true;
  const wanted = args.type?.toUpperCase();
  const all = getAllItems(mirror.world, mirror.components)
    .filter((i) => i.index)
    .filter((i) => (wanted === undefined ? true : (i.type ?? '').toUpperCase() === wanted))
    .sort((a, b) => a.index - b.index);
  const items = all.map((i) => ({
    ...toItemOut(i, full),
    ...(enrich ? itemRegistryEnrichment(mirror, i) : {}),
  }));
  return { itemsTotal: items.length, items, pools: poolsQuery(mirror) };
}

// --------------------------------------------------------------- pools

export type PoolOut = {
  /** pool entity id */
  id: string;
  /** the traded pair, item registry indices, canonically sorted low first */
  items: number[];
  /** reserve of each item, positionally aligned to `items` */
  reserves: number[];
  /** swap fee in basis points (10000 = 100%) */
  feeBps: number;
  /** total liquidity-provider shares outstanding */
  lpSupply: number;
  /** pool creation timestamp, seconds */
  startTime: number;
  /** present and true when the pool is paused */
  disabled?: boolean;
  /** PURE RESERVE RATIO — excludes the fee and excludes price impact.
   * It is a valuation of the current depth, NOT a swap quote: an actual
   * swap moves along the constant-product curve and pays feeBps. Omitted
   * when either reserve is zero. */
  impliedRate?: { item0PerItem1: number; item1PerItem0: number };
};

/** Item pools (0.3.0) — the constant-product item-swap venues that exist as
 * world state.
 *
 * FACTS ONLY, deliberately. The reserves, the fee, the share supply and the
 * creation time are read out of the mirror and are chain-verifiable per row.
 * The swap-output formula is NOT served: the pinned client carries no pool
 * module, so there is no upstream implementation to be faithful to and no
 * differential gate that could catch a transcription error in one. A
 * consumer holding the two reserves and the fee has everything the formula
 * consumes. Quoting arrives with a pin whose client ships the pool module.
 *
 * Discovery is mirror-only: the entity-type component carries no on-chain
 * reverse index, so "which pools exist" is answerable from the local mirror
 * and not from a chain read — while every row it returns is chain-checkable
 * one entity at a time. Reserves are ordinary inventory balances held by the
 * pool entity itself, read through the same deterministic
 * inventory-instance path every other balance uses. */
export function poolsQuery(mirror: Mirror): PoolOut[] {
  const { world, components } = mirror;
  const { EntityType, Keys, Rate, StartTime, Value } = components;
  const entities = Array.from(runQuery([HasValue(EntityType, { value: 'POOL' })]));

  const pools: PoolOut[] = [];
  for (const entity of entities) {
    const id = world.entities[entity];
    const keys = (getComponentValue(Keys, entity)?.value ?? []) as unknown as number[];
    // a pool is a pair; anything else is not a shape this version serves
    if (!Array.isArray(keys) || keys.length !== 2) continue;
    const items = keys.map((k) => Number(k));
    const reserves = items.map((index) => getItemBalance(world, components, id, index));
    const pool: PoolOut = {
      id,
      items,
      reserves,
      feeBps: Number(getComponentValue(Rate, entity)?.value ?? 0),
      lpSupply: Number(getComponentValue(Value, entity)?.value ?? 0),
      startTime: Number(getComponentValue(StartTime, entity)?.value ?? 0),
    };
    if (getIsDisabled(components, entity)) pool.disabled = true;
    if (reserves[0] > 0 && reserves[1] > 0) {
      pool.impliedRate = {
        item0PerItem1: reserves[0] / reserves[1],
        item1PerItem0: reserves[1] / reserves[0],
      };
    }
    pools.push(pool);
  }
  return pools.sort((a, b) => a.items[0] - b.items[0] || a.items[1] - b.items[1]);
}

// -------------------------------------------------------------- config

export type ConfigOut = {
  name: string;
  /** the stored value as a number — present ONLY when it is exactly
   * representable as one. Unchanged for every field where it ever meant
   * anything (`KAMI_STANDARD_COOLDOWN` is still `180`).
   *
   * §1.2, corrected at 0.5.0: a config Value component holds a uint256, and
   * several fields PACK eight uint32s into one. Coerced with `Number()`,
   * `KAMI_HARV_INTENSITY` used to serve `1.347997333357532e+68` — a float
   * with no relationship to anything the world holds. A value that does not
   * fit is now ABSENT here rather than wrong, and `valueRaw` carries it. */
  value?: number;
  /** the stored value VERBATIM, as a decimal string, always. For a packed
   * field this is the only honest scalar form; `--array` unpacks it. */
  valueRaw?: string;
  values?: number[];
};

/** One `is.config` field.
 *
 * §3.14: ABSENCE IS NOT ZERO. The underlying reader answers 0 (and eight
 * zeros for the array form) for a field that does not exist, which made a
 * probe for a name nobody ever deployed indistinguishable from a real stored
 * 0. A reader that guesses a plausible-sounding key gets its guess CONFIRMED
 * — which is what happened: an arm queried a fabricated `POOL_*ENABLED`
 * family that exists nowhere upstream, read the zeros as settled fact, and
 * carried the false model for about twenty sessions. A name the world does
 * not hold now answers NOT_FOUND, which is already this surface's documented
 * code for "no such thing". */
export function configQuery(mirror: Mirror, args: { name: string; array?: boolean }): ConfigOut {
  const { world, components } = mirror;
  if (!args.name) throw new QueryError('BAD_ARGS', 'config query needs a field name');
  if (!configFieldExists(world, args.name)) {
    throw new QueryError(
      'NOT_FOUND',
      `no is.config field named '${args.name}' exists in this world — the name is not a config key, not a key whose value is zero`
    );
  }
  if (args.array) {
    return { name: args.name, values: getConfigFieldValueArray(world, components, args.name) };
  }
  const stored = getComponentValue(components.Value, configFieldEntity(world, args.name)!)?.value;
  let exact: bigint;
  try {
    exact = BigInt((stored ?? 0) as string | number);
  } catch {
    exact = 0n;
  }
  const fits = exact <= BigInt(Number.MAX_SAFE_INTEGER) && exact >= BigInt(Number.MIN_SAFE_INTEGER);
  return {
    name: args.name,
    // absent rather than wrong when the stored uint256 cannot be a JS number
    ...(fits ? { value: Number(exact) } : {}),
    valueRaw: exact.toString(),
  };
}

/** The deterministic `is.config` entity for a field name, or undefined when
 * the world holds no such field. Same derivation the ported reader uses. */
function configFieldEntity(world: World, field: string): EntityIndex | undefined {
  return getEntityByHash(world, ['is.config', field], ['string', 'string']);
}

export function configFieldExists(world: World, field: string): boolean {
  return configFieldEntity(world, field) !== undefined;
}

// ----------------------------------------------------------- inventory

/** An item named on a surface where it is HELD or BOUGHT. The three facts
 * added at 0.5.0 (§3.13) — `for`, `rarity`, `disabled` — are the ones the
 * reference client's own item tooltip renders and this surface did not carry:
 * `for` because a kami food and an account food are both `type: FOOD` and
 * indistinguishable without it (one merchant catalog at this pin sells
 * "Maple-Flavor Ghost Gum" for KAMI beside "Ice Cream" for ACCOUNT), rarity
 * and disabled because the tooltip shows both. All three are already on the
 * full item shape these rows are projected from — no new read. */
export type InventoryItemOut = {
  /** dropped on a COMPACTED listing row (§3.13) — a merchant catalog names
   * the item to buy by index, and the row's own `id` is what a purchase
   * acts on. Always present where the row is not a compacted listing. */
  id?: string;
  index: number;
  name: string;
  type: string;
  /** §3.13: KAMI / ACCOUNT / … — omitted when the world holds no target */
  for?: string;
  /** §3.13 */
  rarity: number;
  /** §3.13: present and true only when the registry marks the item disabled */
  disabled?: boolean;
  /** §3.12 (enrich): the tooltip facts — what it is, what using or
   * equipping it does, and what using it requires. `Inventory.item` is
   * a FULL item shape, so none of this costs a further read. */
  description?: string;
  effects?: { use: AlloOut[]; equip: AlloOut[] };
  requirements?: ItemRequirementOut[];
};

export function toInventoryItemOut(
  mirror: Mirror,
  item: ShapeItem,
  enrich: boolean,
  withId = true
): InventoryItemOut {
  return {
    ...(withId ? { id: item.id } : {}),
    index: item.index,
    name: item.name,
    type: item.type,
    ...(item.for ? { for: item.for } : {}),
    rarity: item.rarity ?? 0,
    ...(item.is?.disabled ? { disabled: true } : {}),
    ...(enrich ? itemEnrichment(mirror, item) : {}),
  };
}

export type InventoryOut = {
  account: { index: number; name: string };
  items: { balance: number; item: InventoryItemOut }[];
};

/** Any-account item inventory (0.2.0). Rows go through the inventory
 * modal's own prep (cleanInventories: zero balances dropped, sorted by
 * item index); MUSU/OBOL rows are data like any other — the modal's grid
 * hides MUSU as UI layout, not as a data rule. */
export function inventoryQuery(
  mirror: Mirror,
  args: { index?: number; name?: string },
  enrich = false
): InventoryOut {
  const { world, components } = mirror;
  const account =
    args.index !== undefined
      ? getAccountByIndex(world, components, args.index, { inventory: true })
      : args.name !== undefined
        ? getAccountByName(world, components, args.name, { inventory: true })
        : undefined;
  if (!account) throw new QueryError('BAD_ARGS', 'inventory query needs an account index or name');
  if (!account.index) {
    throw new QueryError('NOT_FOUND', `account ${args.index ?? args.name} not in mirror`);
  }
  return {
    account: { index: account.index, name: account.name },
    items: cleanInventories(account.inventories ?? []).map((inv) => ({
      balance: inv.balance,
      item: toInventoryItemOut(mirror, inv.item, enrich),
    })),
  };
}

// ---------------------------------------------------------------- room

/** One way out of a room: where it leads, and the conditions the world
 * stores on passing through it. FACTS ONLY — whether a given account passes
 * them is the reader's own evaluation, and the interpreted text names each
 * condition in the pinned client's own words. */
/** One condition on passing through an exit. Deliberately NOT the
 * `ItemRequirementOut` shape the item surface uses, for one reason: a room
 * gate's `value` is an ENTITY ID, not a count. `Number()` on an id-sized
 * uint returns 2.65e+76 — a number the world does not hold and nobody can
 * join on — so this shape keeps the value exactly as the mirror decoded it
 * (§1.2: values are verbatim or absent, never rewritten). The item surface's
 * conditions are index-shaped and small at this pin, so its coercion is
 * latent there rather than wrong; it is docketed, not changed here. */
export type RoomExitGateOut = ItemRequirementOut;

export type RoomExitOut = {
  toIndex: number;
  name: string;
  /** conditions on entering the destination; empty for an ungated exit */
  gates: RoomExitGateOut[];
};

export function toRoomExitGateOut(mirror: Mirror, con: Condition): RoomExitGateOut {
  // now identical to toConditionOut — the two shapes converged once the
  // item-condition coercion was fixed too
  return toConditionOut(mirror, con);
}

export type RoomOut = {
  index: number;
  name: string;
  /** compacted away by default (§3.13); `--full` restores it */
  description?: string;
  /** §3.13 (0.5.0): where this room CONNECTS. `getExitsFor` has been in the
   * ported tree since 0.1.0 and no query ever called it, so no served surface
   * anywhere named a room connection — a reader could learn the map only by
   * moving and failing, which §3.11 exists to refuse. Served verbatim as the
   * pinned client computes it: special exits (the room's `Exits` component)
   * followed by geometric neighbours, NOT de-duplicated and NOT symmetrised,
   * because the client renders exactly this list. */
  exits: RoomExitOut[];
  accountsTotal: number;
  accountsServed: number;
  accounts: {
    /** `--full` only */
    id?: string;
    index: number;
    name: string;
    /** compact form: how many kamis the account has here */
    kamiCount?: number;
    /** `--full` only: the kamis themselves */
    kamis?: { id: string; index: number; name: string; state: string }[];
  }[];
};

/** Room occupancy (0.2.0): the `RoomIndex == here` reverse lookup the
 * client's map presence uses (explorer rooms.getPlayers pattern), each
 * account joined with its kamis exactly as the account query serves them.
 *
 * 0.5.0 (§3.13): the occupant list is COMPACT by default — one row per
 * account with a kami COUNT rather than the roster — and capped, because the
 * crowded rooms are very crowded (1,561 accounts and 1,633 kamis measured in
 * one room, a 360 KB answer, and 65 KB even with every row compacted). Rows
 * are ordered by account index unconditionally so the capped answer and the
 * `--full` answer agree about which rows come first. */
export function roomQuery(
  mirror: Mirror,
  args: { index: number; full?: boolean }
): RoomOut {
  const { world, components } = mirror;
  const full = args.full === true;
  // {exits: true} is the ONE fact on this surface that costs a read the
  // answer did not already make: getAdjacentRoomIndices probes the six
  // neighbouring locations. Measured at 0.026 ms per room.
  const room = getRoomByIndex(world, components, args.index, { exits: true });
  if (!room || !room.index) {
    throw new QueryError('NOT_FOUND', `room ${args.index} not in mirror`);
  }
  const exits: RoomExitOut[] = (room.exits ?? getExitsFor(world, components, room)).map(
    (exit) => {
      let name = '';
      try {
        name = getRoomByIndex(world, components, exit.toIndex)?.name ?? '';
      } catch {
        /* an exit to a room index the mirror has no entity for */
      }
      return {
        toIndex: exit.toIndex,
        name,
        gates: (exit.gates ?? []).map((g) => toRoomExitGateOut(mirror, g)),
      };
    }
  );
  const all = queryRoomAccounts(components, args.index)
    .map((entity) => getAccount(world, components, entity, { kamis: true }))
    .filter((account) => account.index)
    .sort((a, b) => a.index - b.index)
    .map((account) => {
      const kamis = (account.kamis ?? []).map((k) => ({
        id: k.id,
        index: k.index,
        name: k.name,
        state: k.state,
      }));
      return full
        ? { id: account.id, index: account.index, name: account.name, kamis }
        : { index: account.index, name: account.name, kamiCount: kamis.length };
    });
  const { served, total } = capRows(all, full);
  return {
    index: room.index,
    name: room.name,
    ...(full ? { description: room.description ?? '' } : {}),
    exits,
    accountsTotal: total,
    accountsServed: served.length,
    accounts: served,
  };
}

// ------------------------------------------------------------ merchant

export type ListingOut = {
  id: string;
  /** the same shape an inventory row carries — this is the surface where an
   * item is BOUGHT, so the target, rarity and disabled flag belong here for
   * exactly the reasons they belong there (§3.13) */
  item: InventoryItemOut;
  /** the payment currency: description only (identity, not a use decision) */
  payItem: { index: number; name?: string; description?: string };
  value: number;
  balance: number;
  /** `--full` only from 0.5.0 (§3.13) */
  startTime?: number;
  buy?: { type: string; period?: number; decay?: number; rate?: number };
  sell?: { type: string; scale?: number };
  /** unit price on the ported calc (GDA is clock-corrected, §3.8);
   * present exactly when the listing has that pricing side */
  buyPrice?: number;
  sellPrice?: number;
  /** interpreted requirement text (registry prose; account-side gating —
   * prices never vary by viewer, only visibility does) */
  requirements: string[];
};

export type NewbieVendorOut = {
  /** the kami indices purchasable RIGHT NOW — the display window */
  displayedKamiIndices: number[];
  /** how many kami indices the vendor holds in total */
  poolSize: number;
  /** cycle anchor, seconds */
  cycleStart: number;
  /** rotation period, seconds */
  cycleSeconds: number;
  /** seconds until the display window advances */
  secondsToNextRotation: number;
};

export type MerchantOut = {
  merchants: { index: number; name: string; roomIndex: number }[];
  listings?: ListingOut[];
  /** the starter vendor's rotating display window (0.3.0), served on the
   * merchant enumeration */
  newbieVendor?: NewbieVendorOut;
};

// The vendor entity id, the same derivation the projection layer uses
// (network/shapes/NewbieVendor/queries.ts).
const NEWBIE_VENDOR_ID = formatEntityID(keccakOfString('newbie.vendor'));

/** The starter vendor sells only the kamis in its current display window,
 * and rejects a purchase outside it. The window is world state — a stored
 * pool of indices, a stored cycle anchor and a configured period — so it is
 * readable BEFORE the attempt rather than discoverable only by failing one.
 * The window itself comes from the projection layer's own cycle
 * computation; the surrounding facts are read off the same entity. */
function newbieVendorState(mirror: Mirror): NewbieVendorOut | undefined {
  const { world, components } = mirror;
  const entity = world.entityToIndex.get(NEWBIE_VENDOR_ID);
  if (entity === undefined) return undefined;
  const pool = (getComponentValue(components.Values, entity)?.value ?? []) as unknown as number[];
  const cycleStart = Number(getComponentValue(components.StartTime, entity)?.value ?? 0);
  const cycleSeconds = Number(getConfigFieldValue(world, components, 'NEWBIE_VENDOR_CYCLE') ?? 0);
  const now = Math.floor(clock.now() / 1000);
  const elapsed = cycleSeconds > 0 && now > cycleStart ? (now - cycleStart) % cycleSeconds : 0;
  return {
    // Number() coercion: the mirror decodes this numeric array as hex
    // strings; the served surface is honest numbers (the same phantom-type
    // handling the quest instance times get)
    displayedKamiIndices: getDisplayedKamiIndices(world, components).map((i) => Number(i)),
    poolSize: Array.isArray(pool) ? pool.length : 0,
    cycleStart,
    cycleSeconds,
    secondsToNextRotation: cycleSeconds > 0 ? cycleSeconds - elapsed : 0,
  };
}

function toListingOut(
  mirror: Mirror,
  listing: Listing,
  enrich = false,
  full = false
): ListingOut {
  const { world, components } = mirror;
  const requirements = listing.requirements.map((con) => {
    try {
      return parseConditionalText(world, components, con);
    } catch {
      return con.target?.type ?? '';
    }
  });
  return {
    id: listing.id,
    item: toInventoryItemOut(mirror, listing.item, enrich, full),
    payItem: {
      index: listing.payItem.index,
      ...(full ? { name: listing.payItem.name } : {}),
      ...(enrich ? { description: listing.payItem.description ?? '' } : {}),
    },
    value: listing.value,
    balance: listing.balance,
    ...(full ? { startTime: listing.startTime } : {}),
    ...(listing.buy
      ? {
          buy: {
            type: listing.buy.type,
            ...(listing.buy.period !== undefined ? { period: listing.buy.period } : {}),
            ...(listing.buy.decay !== undefined ? { decay: listing.buy.decay } : {}),
            ...(listing.buy.rate !== undefined ? { rate: listing.buy.rate } : {}),
          },
          buyPrice: calcListingBuyPrice(listing, 1),
        }
      : {}),
    ...(listing.sell
      ? {
          sell: {
            type: listing.sell.type,
            ...(listing.sell.scale !== undefined ? { scale: listing.sell.scale } : {}),
          },
          sellPrice: calcListingSellPrice(listing, 1),
        }
      : {}),
    requirements,
  };
}

/** NPC merchant stock + prices (0.2.0), all chain state. Without an index:
 * every NPC in the mirror. With one: that merchant plus its full listing
 * catalog, unit prices via the client's own calcs (buy is what the
 * merchant modal displays; sell served where the pricing side exists).
 * The catalog is unfiltered — requirement gating is per-viewer visibility,
 * served as interpreted text, never applied silently. */
export function merchantQuery(
  mirror: Mirror,
  args: { index?: number; full?: boolean },
  enrich = false
): MerchantOut {
  const { world, components } = mirror;
  if (args.index === undefined) {
    const merchants = getAllNPCs(world, components)
      .filter((npc) => npc.index)
      .sort((a, b) => a.index - b.index)
      .map((npc) => ({ index: npc.index, name: npc.name, roomIndex: npc.roomIndex }));
    const newbieVendor = newbieVendorState(mirror);
    return { merchants, ...(newbieVendor ? { newbieVendor } : {}) };
  }
  const npc = getNPCByIndex(world, components, args.index, { listings: true });
  if (!npc || !npc.index) {
    throw new QueryError('NOT_FOUND', `npc ${args.index} not in mirror`);
  }
  return {
    merchants: [{ index: npc.index, name: npc.name, roomIndex: npc.roomIndex }],
    listings: npc.listings
      .slice()
      .sort((a, b) => a.item.index - b.item.index)
      .map((l) => toListingOut(mirror, l, enrich, args.full === true)),
  };
}

// --------------------------------------------------------------- phase

export type PhaseOut = {
  /** 1 DAYLIGHT · 2 EVENFALL · 3 MOONSIDE (utils/time getPhaseOf) */
  phase: number;
  name: string;
  /** hour within the 36-hour world day (0–35) */
  cycleHour: number;
  secondsToNext: number;
  next: string;
  /** the corrected-clock timestamp (ms) the answer was computed at */
  at: number;
};

/** World day/night phase (0.2.0): the ported 36-hour-cycle formula on the
 * offset-corrected clock (§3.8). The cycle is pure pinned code — no
 * is.config input exists at this pin; a phase-constant change arrives as a
 * pin advance, not a config read. secondsToNext is boundary arithmetic on
 * the same constants (phases flip when epoch-seconds cross a 12-hour
 * multiple). */
export function phaseQuery(): PhaseOut {
  const at = clock.now();
  const seconds = Math.floor(at / 1000);
  const phase = getPhaseOf(at);
  return {
    phase,
    name: getPhaseName(phase),
    cycleHour: Math.floor(seconds / 3600) % 36,
    secondsToNext: 43200 - (seconds % 43200),
    next: getPhaseName((phase % 3) + 1),
    at,
  };
}

// --------------------------------------------------------- leaderboard

export type LeaderboardOut = {
  type: string;
  epoch: number;
  itemIndex: number;
  /** §3.13 (0.5.0): how many ranked rows exist, whether or not this answer
   * served them. 1,475 rows measured at one pin, a 175 KB answer. */
  rowsTotal: number;
  rowsServed: number;
  rows: {
    rank: number;
    account: { id?: string; index?: number; name?: string };
    value: number;
  }[];
};

/** Mirror Score leaderboard (0.2.0): the client's leaderboard modal query
 * verbatim — getScoresByFilter over (epoch, itemIndex, type), rows sorted
 * by value descending with 1-based rank, holder joined to its account the
 * way the modal's table does. Defaults mirror the modal's own initial
 * filter (COLLECT, epoch 1, MUSU). Any type string is queryable — an
 * unknown type simply matches no score entities. */
export function leaderboardQuery(
  mirror: Mirror,
  args: { type: string; epoch: number; itemIndex: number; full?: boolean }
): LeaderboardOut {
  const { world, components } = mirror;
  const full = args.full === true;
  const scores = getScoresByFilter(components, {
    epoch: args.epoch,
    index: args.itemIndex,
    type: args.type,
  });
  // already value-sorted by the ported query: the cap is the top N, which is
  // the natural reading of a leaderboard (§3.13)
  const rows = scores.map((score, i) => {
    const account: LeaderboardOut['rows'][number]['account'] = {};
    // the raw holder id is `--full` only: it is a 66-character hex string on
    // every row and the account INDEX is what a consumer joins on
    if (full) account.id = score.holderID;
    try {
      const holder = getAccountByID(world, components, score.holderID);
      if (holder.index) {
        account.index = holder.index;
        account.name = holder.name;
      }
    } catch {
      /* non-account holder — serve the bare id */
    }
    if (account.index === undefined && !full) account.id = score.holderID;
    return { rank: i + 1, account, value: score.value };
  });
  const { served, total } = capRows(rows, full);
  return {
    type: args.type,
    epoch: args.epoch,
    itemIndex: args.itemIndex,
    rowsTotal: total,
    rowsServed: served.length,
    rows: served,
  };
}

// ------------------------------------------------------- shared helper

/** Kami entity resolution shared with the stateless path: deterministic
 * hash first (G0 vectors), query fallback — the upstream queryByIndex
 * behavior, reused so both modes resolve identically. */
export function resolveKamiEntity(mirror: Mirror, index: number): EntityIndex | undefined {
  return queryKamiByIndex(mirror.world, mirror.components, index);
}

export { getShapeKami, queryAccountEntityByIndex };
