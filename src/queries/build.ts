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
import { EntityIndex, World } from 'engine/recs';
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
import { getAllItems, getItemByIndex } from 'network/shapes/Item';
import { getKami as getShapeKami } from 'network/shapes/Kami';
import { queryByIndex as queryKamiByIndex } from 'network/shapes/Kami/queries';
import { Listing } from 'network/shapes/Listing';
import { getNodeByIndex } from 'network/shapes/Node';
import { queryHarvests } from 'network/shapes/Node/harvests';
import { queryByIndex as queryNodeEntityByIndex } from 'network/shapes/Node/queries';
import { getAllNPCs, getNPCByIndex } from 'network/shapes/Npc';
import { getRoomByIndex } from 'network/shapes/Room';
import { getScoresByFilter } from 'network/shapes/Score';
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

const KAMI_REFRESH = {
  live: 0,
  base: 0,
  bonuses: 0,
  config: 0,
  flags: 0,
  harvest: 0,
  progress: 0,
  rerolls: 0,
  skills: 0,
  stats: 0,
  time: 0,
  traits: 0,
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

// ---------------------------------------------------------------- item

export type ItemOut = {
  id: string;
  index: number;
  name: string;
  type: string;
  description: string;
  for: string;
  rarity: number;
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
  return toItemOut(item);
}

export function itemsQuery(mirror: Mirror): { items: ItemOut[] } {
  const items = getAllItems(mirror.world, mirror.components)
    .filter((i) => i.index)
    .sort((a, b) => a.index - b.index)
    .map(toItemOut);
  return { items };
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

export type MerchantOut = {
  merchants: { index: number; name: string; roomIndex: number }[];
  listings?: ListingOut[];
};

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
    return { merchants };
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
