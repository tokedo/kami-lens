// kami-lens native module (not a port): query output builders (DESIGN §4.3).
//
// Each builder materializes a compact, schema-checked output from the
// mirror, through the same ported data path the web client renders from
// (app/cache getters with forced refresh — the G2.b-verified path), so
// query answers inherit display parity. Output shapes are deliberate,
// versioned kami-lens surfaces (checked-in JSON schemas in
// src/queries/schemas; string classes in docs/string-classification.json);
// they are NOT the raw upstream shapes.

import {
  calcCooldown,
  calcHealth,
  calcHealthPercent,
  calcOutput,
  getKami,
  getKamiAccount,
} from 'app/cache/kami';
import { KamiCache } from 'app/cache/kami/base';
import { EntityIndex, World } from 'engine/recs';
import { Components } from 'network/';
import { getAccountByIndex, getAccountByName } from 'network/shapes/Account';
import { queryByIndex as queryAccountEntityByIndex } from 'network/shapes/Account/queries';
import { getConfigFieldValue, getConfigFieldValueArray } from 'network/shapes/Config';
// getHarvestKami (Harvest/kami.ts), NOT getHarvest's {kami:true} option —
// that option is a dormant upstream defect (see Harvest/types.ts header).
import { getHarvest, getHarvestKami } from 'network/shapes/Harvest';
import { getAllItems, getItemByIndex } from 'network/shapes/Item';
import { getKami as getShapeKami } from 'network/shapes/Kami';
import { queryByIndex as queryKamiByIndex } from 'network/shapes/Kami/queries';
import { getNodeByIndex } from 'network/shapes/Node';
import { queryHarvests } from 'network/shapes/Node/harvests';
import { queryByIndex as queryNodeEntityByIndex } from 'network/shapes/Node/queries';
import { getRateDisplay } from 'utils/numbers';

export type Mirror = {
  world: World;
  components: Components;
  blockNumber: number;
};

export class QueryError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'BAD_ARGS',
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
  const options = { kamis: true, ...(opts.prose ? { bio: true } : {}) };
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

export type NodeOut = {
  index: number;
  name: string;
  type: string;
  affinity: string[];
  roomIndex: number;
  description: string;
  harvests: {
    id: string;
    state: string;
    kami: { id: string; index: number; name: string };
    account: { index: number; name: string };
  }[];
};

export function nodeQuery(mirror: Mirror, args: { index: number }): NodeOut {
  const { world, components } = mirror;
  const node = getNodeByIndex(world, components, args.index);
  if (!node || !node.index) {
    throw new QueryError('NOT_FOUND', `node ${args.index} not in mirror`);
  }
  const nodeEntity = queryNodeEntityByIndex(world, args.index);
  const harvestEntities = queryHarvests(world, components, nodeEntity);
  const harvests = harvestEntities.map((h) => {
    const harvest = getHarvest(world, components, h);
    const kami = getHarvestKami(world, components, h);
    const owner = kami ? getKamiAccount(world, components, kami.entity) : undefined;
    return {
      id: harvest.id,
      state: harvest.state,
      kami: kami
        ? { id: kami.id, index: kami.index, name: kami.name }
        : { id: '0x0', index: 0, name: '' },
      account: owner?.index ? { index: owner.index, name: owner.name } : { index: 0, name: '' },
    };
  });
  return {
    index: node.index,
    name: node.name,
    type: node.type,
    affinity: Array.isArray(node.affinity) ? node.affinity : [node.affinity].filter(Boolean),
    roomIndex: node.roomIndex,
    description: node.description ?? '',
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

// ------------------------------------------------------- shared helper

/** Kami entity resolution shared with the stateless path: deterministic
 * hash first (G0 vectors), query fallback — the upstream queryByIndex
 * behavior, reused so both modes resolve identically. */
export function resolveKamiEntity(mirror: Mirror, index: number): EntityIndex | undefined {
  return queryKamiByIndex(mirror.world, mirror.components, index);
}

export { getShapeKami, queryAccountEntityByIndex };
