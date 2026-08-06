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

import { calcCurrentStamina } from 'app/cache/account';
import { cleanInventories } from 'app/cache/inventory';
import {
  calcCooldown,
  calcHealth,
  calcHealthPercent,
  calcOutput,
  getKami,
  getKamiAccount,
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
  queryRoomAccounts,
} from 'network/shapes/Account';
import { queryByIndex as queryAccountEntityByIndex } from 'network/shapes/Account/queries';
import { parseConditionalText } from 'network/shapes/Conditional';
import { getConfigFieldValue, getConfigFieldValueArray } from 'network/shapes/Config';
// getHarvestKami (Harvest/kami.ts), NOT getHarvest's {kami:true} option —
// that option is a dormant upstream defect (see Harvest/types.ts header).
import { getHarvest, getHarvestKami } from 'network/shapes/Harvest';
import { getAllItems, getItemBalance, getItemByIndex } from 'network/shapes/Item';
import { getKami as getShapeKami } from 'network/shapes/Kami';
import { queryByIndex as queryKamiByIndex } from 'network/shapes/Kami/queries';
import { Listing } from 'network/shapes/Listing';
import { getNodeByIndex } from 'network/shapes/Node';
import { queryHarvests } from 'network/shapes/Node/harvests';
import { queryByIndex as queryNodeEntityByIndex } from 'network/shapes/Node/queries';
import { getDisplayedKamiIndices } from 'network/shapes/NewbieVendor/queries';
import { getAllNPCs, getNPCByIndex } from 'network/shapes/Npc';
import { getRoomByIndex } from 'network/shapes/Room';
import { getScoresByFilter } from 'network/shapes/Score';
import { getIsDisabled } from 'network/shapes/utils/component';
import { getRateDisplay } from 'utils/numbers';
import { getPhaseName, getPhaseOf } from 'utils/time';

export type Mirror = {
  world: World;
  components: Components;
  blockNumber: number;
};

export class QueryError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'BAD_ARGS' | 'KAMIDEN_UNAVAILABLE' | 'CHAT_DISABLED',
    message: string
  ) {
    super(message);
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

// ---------------------------------------------------------------- kami

export type KamiVitals = {
  id: string;
  index: number;
  name: string;
  state: string;
  level?: number;
  hp: { current: number; total: number; percent: number };
  hpRatePerHr: string;
  musu?: { accrued: number; spotRatePerHr: string; avgRatePerHr: string };
  cooldownSec: number;
  node?: { index: number; name: string };
  account?: { index: number; name: string };
};

export function buildKamiVitals(mirror: Mirror, entity: EntityIndex): KamiVitals {
  const { world, components } = mirror;
  KamiCache.clear();
  const kami = getKami(world, components, entity, KAMI_REFRESH);
  const hp = calcHealth(kami);
  const total = kami.stats?.health.total ?? 0;
  const owner = getKamiAccount(world, components, entity);
  const vitals: KamiVitals = {
    id: kami.id,
    index: kami.index,
    name: kami.name,
    state: kami.state,
    level: kami.progress?.level,
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
  return vitals;
}

export function kamiQuery(mirror: Mirror, args: { index: number }): KamiVitals {
  const entity = queryKamiByIndex(mirror.world, mirror.components, args.index);
  if (entity === undefined) throw new QueryError('NOT_FOUND', `kami ${args.index} not in mirror`);
  return buildKamiVitals(mirror, entity);
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
  /** current = calcCurrentStamina (recovery-adjusted, the Clock fixture's
   * display value); total = the stat's computed cap (0.2.0 addition) */
  stamina: { current: number; total: number };
  reputation: { agency: number; mina: number; nursery: number };
  kamis: { id: string; index: number; name: string; state: string }[];
  bio?: string;
};

export function accountQuery(
  mirror: Mirror,
  args: { index?: number; name?: string },
  opts: { prose?: boolean } = {}
): AccountOut {
  const { world, components } = mirror;
  // config: calcCurrentStamina reads config.stamina.recovery (the Clock
  // fixture fetches the account the same way)
  const options = { kamis: true, config: true, ...(opts.prose ? { bio: true } : {}) };
  const account =
    args.index !== undefined
      ? getAccountByIndex(world, components, args.index, options)
      : args.name !== undefined
        ? getAccountByName(world, components, args.name, options)
        : undefined;
  if (!account) throw new QueryError('BAD_ARGS', 'account query needs index or name');
  if (!account.index) {
    throw new QueryError('NOT_FOUND', `account ${args.index ?? args.name} not in mirror`);
  }
  return {
    id: account.id,
    index: account.index,
    name: account.name,
    ownerAddress: account.ownerAddress,
    operatorAddress: account.operatorAddress,
    roomIndex: account.roomIndex,
    musu: account.coin,
    stamina: { current: calcCurrentStamina(account), total: account.stamina.total },
    reputation: account.reputation,
    kamis: (account.kamis ?? []).map((k) => ({
      id: k.id,
      index: k.index,
      name: k.name,
      state: k.state,
    })),
    ...(opts.prose && account.bio !== undefined ? { bio: account.bio } : {}),
  };
}

// ---------------------------------------------------------------- node

export type HarvestVitals = {
  hp: { current: number; total: number; percent: number };
  hpRatePerHr: string;
  /** calcOutput — the realizable MUSU at stake in this harvest */
  musuAccrued: number;
  cooldownSec: number;
};

export type LiquidationPreview = {
  /** canLiquidate(attacker, occupant) — cooldown/starving gates included */
  eligible: boolean;
  /** HP cutoff: attacker can liquidate while occupant HP is below this */
  threshold: number;
  spoils: number;
  salvage: number;
  recoil: number;
};

export type NodeOut = {
  index: number;
  name: string;
  type: string;
  affinity: string[];
  roomIndex: number;
  description: string;
  /** echoed with the attacker-kami argument (vitals mode only) */
  attacker?: { id: string; index: number; name: string; cooldownSec: number };
  harvests: {
    id: string;
    state: string;
    kami: { id: string; index: number; name: string };
    account: { index: number; name: string };
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
  args: { index: number; withVitals?: boolean; attacker?: number }
): NodeOut {
  const { world, components } = mirror;
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

  const harvests = harvestEntities.map((h) => {
    const harvest = getHarvest(world, components, h);
    const kami = getHarvestKami(world, components, h);
    const owner = kami ? getKamiAccount(world, components, kami.entity) : undefined;
    const row: NodeOut['harvests'][number] = {
      id: harvest.id,
      state: harvest.state,
      kami: kami
        ? { id: kami.id, index: kami.index, name: kami.name }
        : { id: '0x0', index: 0, name: '' },
      account: owner?.index ? { index: owner.index, name: owner.name } : { index: 0, name: '' },
    };
    if (args.withVitals && kami) {
      const occupant = getKami(world, components, kami.entity, KAMI_REFRESH);
      const hp = calcHealth(occupant);
      row.vitals = {
        hp: {
          current: hp,
          total: occupant.stats?.health.total ?? 0,
          percent: Number(calcHealthPercent(occupant).toFixed(0)),
        },
        hpRatePerHr: getRateDisplay(occupant.stats?.health.rate, 2),
        musuAccrued: calcOutput(occupant),
        cooldownSec: Math.max(0, Math.floor(calcCooldown(occupant))),
      };
      if (attackerKami && occupant.id !== attackerKami.id) {
        row.liquidation = {
          eligible: canLiquidate(attackerKami, occupant),
          threshold: calcLiqThreshold(attackerKami, occupant),
          spoils: calcLiqSpoils(attackerKami, occupant),
          salvage: calcLiqSalvage(occupant),
          recoil: calcLiqRecoil(attackerKami, occupant),
        };
      }
    }
    return row;
  });
  return {
    index: node.index,
    name: node.name,
    type: node.type,
    affinity: Array.isArray(node.affinity) ? node.affinity : [node.affinity].filter(Boolean),
    roomIndex: node.roomIndex,
    description: node.description ?? '',
    ...(attackerOut ? { attacker: attackerOut } : {}),
    harvests,
  };
}

// --------------------------------------------------------------- party

export type PartyOut = {
  account: { index: number; name: string };
  kamis: KamiVitals[];
};

export function partyQuery(mirror: Mirror, args: { accountIndex: number }): PartyOut {
  const { world, components } = mirror;
  const account = getAccountByIndex(world, components, args.accountIndex, { kamis: true });
  if (!account.index) {
    throw new QueryError('NOT_FOUND', `account ${args.accountIndex} not in mirror`);
  }
  const kamis = (account.kamis ?? []).map((k) => buildKamiVitals(mirror, k.entity));
  return { account: { index: account.index, name: account.name }, kamis };
}

// --------------------------------------------------------------- roster

export type RosterOut = {
  /** no account name: the roster is deliberately name-free (see below) */
  account: { index: number; roomIndex: number };
  kamis: { index: number; state: string; hp: number[] }[];
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
export function rosterQuery(mirror: Mirror, args: { accountIndex: number }): RosterOut {
  const { world, components } = mirror;
  const account = getAccountByIndex(world, components, args.accountIndex, { kamis: true });
  if (!account.index) {
    throw new QueryError('NOT_FOUND', `account ${args.accountIndex} not in mirror`);
  }
  const kamis = (account.kamis ?? []).map((k) => {
    const vitals = buildKamiVitals(mirror, k.entity);
    return {
      index: vitals.index,
      state: vitals.state,
      hp: [vitals.hp.current, vitals.hp.total],
    };
  });
  return { account: { index: account.index, roomIndex: account.roomIndex }, kamis };
}

// ---------------------------------------------------------------- item

export type ItemOut = {
  id: string;
  index: number;
  name: string;
  type: string;
  description: string;
  for: string;
  rarity: number;
  /** pools trading this item (0.3.0); present on the single-item answer,
   * an empty array when the item trades in none */
  pools?: PoolOut[];
};

function toItemOut(item: {
  id: string;
  index: number;
  name: string;
  type: string;
  description?: string;
  for?: string;
  rarity?: number;
}): ItemOut {
  return {
    id: item.id,
    index: item.index,
    name: item.name,
    type: item.type,
    description: item.description ?? '',
    for: item.for ?? '',
    rarity: item.rarity ?? 0,
  };
}

export function itemQuery(mirror: Mirror, args: { index: number }): ItemOut {
  const item = getItemByIndex(mirror.world, mirror.components, args.index);
  if (!item || !item.index) throw new QueryError('NOT_FOUND', `item ${args.index} not in mirror`);
  const pools = poolsQuery(mirror).filter((p) => p.items.includes(args.index));
  return { ...toItemOut(item), pools };
}

export function itemsQuery(mirror: Mirror): { items: ItemOut[]; pools: PoolOut[] } {
  const items = getAllItems(mirror.world, mirror.components)
    .filter((i) => i.index)
    .sort((a, b) => a.index - b.index)
    .map(toItemOut);
  return { items, pools: poolsQuery(mirror) };
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
  value?: number;
  values?: number[];
};

export function configQuery(mirror: Mirror, args: { name: string; array?: boolean }): ConfigOut {
  const { world, components } = mirror;
  if (!args.name) throw new QueryError('BAD_ARGS', 'config query needs a field name');
  if (args.array) {
    return { name: args.name, values: getConfigFieldValueArray(world, components, args.name) };
  }
  return { name: args.name, value: getConfigFieldValue(world, components, args.name) };
}

// ----------------------------------------------------------- inventory

export type InventoryOut = {
  account: { index: number; name: string };
  items: {
    balance: number;
    item: { id: string; index: number; name: string; type: string };
  }[];
};

/** Any-account item inventory (0.2.0). Rows go through the inventory
 * modal's own prep (cleanInventories: zero balances dropped, sorted by
 * item index); MUSU/OBOL rows are data like any other — the modal's grid
 * hides MUSU as UI layout, not as a data rule. */
export function inventoryQuery(
  mirror: Mirror,
  args: { index?: number; name?: string }
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
      item: {
        id: inv.item.id,
        index: inv.item.index,
        name: inv.item.name,
        type: inv.item.type,
      },
    })),
  };
}

// ---------------------------------------------------------------- room

export type RoomOut = {
  index: number;
  name: string;
  description: string;
  accounts: {
    id: string;
    index: number;
    name: string;
    kamis: { id: string; index: number; name: string; state: string }[];
  }[];
};

/** Room occupancy (0.2.0): the `RoomIndex == here` reverse lookup the
 * client's map presence uses (explorer rooms.getPlayers pattern), each
 * account joined with its kamis exactly as the account query serves them. */
export function roomQuery(mirror: Mirror, args: { index: number }): RoomOut {
  const { world, components } = mirror;
  const room = getRoomByIndex(world, components, args.index);
  if (!room || !room.index) {
    throw new QueryError('NOT_FOUND', `room ${args.index} not in mirror`);
  }
  const accounts = queryRoomAccounts(components, args.index)
    .map((entity) => getAccount(world, components, entity, { kamis: true }))
    .filter((account) => account.index)
    .map((account) => ({
      id: account.id,
      index: account.index,
      name: account.name,
      kamis: (account.kamis ?? []).map((k) => ({
        id: k.id,
        index: k.index,
        name: k.name,
        state: k.state,
      })),
    }));
  return {
    index: room.index,
    name: room.name,
    description: room.description ?? '',
    accounts,
  };
}

// ------------------------------------------------------------ merchant

export type ListingOut = {
  id: string;
  item: { id: string; index: number; name: string; type: string };
  payItem: { index: number; name: string };
  value: number;
  balance: number;
  startTime: number;
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

function toListingOut(mirror: Mirror, listing: Listing): ListingOut {
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
    item: {
      id: listing.item.id,
      index: listing.item.index,
      name: listing.item.name,
      type: listing.item.type,
    },
    payItem: { index: listing.payItem.index, name: listing.payItem.name },
    value: listing.value,
    balance: listing.balance,
    startTime: listing.startTime,
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
export function merchantQuery(mirror: Mirror, args: { index?: number }): MerchantOut {
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
    listings: npc.listings.map((l) => toListingOut(mirror, l)),
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
  rows: {
    rank: number;
    account: { id: string; index?: number; name?: string };
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
  args: { type: string; epoch: number; itemIndex: number }
): LeaderboardOut {
  const { world, components } = mirror;
  const scores = getScoresByFilter(components, {
    epoch: args.epoch,
    index: args.itemIndex,
    type: args.type,
  });
  const rows = scores.map((score, i) => {
    const account: LeaderboardOut['rows'][number]['account'] = { id: score.holderID };
    try {
      const holder = getAccountByID(world, components, score.holderID);
      if (holder.index) {
        account.index = holder.index;
        account.name = holder.name;
      }
    } catch {
      /* non-account holder — serve the bare id */
    }
    return { rank: i + 1, account, value: score.value };
  });
  return { type: args.type, epoch: args.epoch, itemIndex: args.itemIndex, rows };
}

// ------------------------------------------------------- shared helper

/** Kami entity resolution shared with the stateless path: deterministic
 * hash first (G0 vectors), query fallback — the upstream queryByIndex
 * behavior, reused so both modes resolve identically. */
export function resolveKamiEntity(mirror: Mirror, index: number): EntityIndex | undefined {
  return queryKamiByIndex(mirror.world, mirror.components, index);
}

export { getShapeKami, queryAccountEntityByIndex };
