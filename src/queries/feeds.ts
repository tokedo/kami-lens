// kami-lens native module (not a port): the M4 query surface — Kamiden
// feeds plus the three M3-deferred chain listings (DESIGN §3.7/§3.10;
// PORT_PLAN M4; the deferral record in docs/coverage.md).
//
// Kamiden-backed builders are PASSTHROUGHS with mirror joins: the unary
// response rows are served verbatim (proto field values unaltered — ids,
// amount strings, timestamps), plus joined refs where the web client
// renders a name for the same row (names inline by default, always
// envelope-tagged, §3.10; joins ADD fields, they never replace the raw
// value). Every Kamiden call goes through the daemon's KamidenFeeds
// supervisor for per-method health accounting — an outage degrades these
// queries with the documented KAMIDEN_UNAVAILABLE code, visibly, never a
// silent gap (§3.2 soft dependency). Request shapes are the web client's
// own, cited per builder.
//
// The chat builder implements the §3.10 chat plan: dedicated paginated
// GetRoomMessages passthrough (invoking the query IS the prose opt-in),
// oversize withhold-with-receipt (never truncated: the body is either
// verbatim or absent with a receipt; the explicit oversize flag serves it
// verbatim), and the config kill-switch (CHAT_DISABLED). Gate G4.c.

import * as clock from 'clock';

import {
  AuctionBuy,
  ItemTransfer,
  KamiMarketBid,
  KamiMarketListing,
  KamiMarketOrder,
  Kill,
  Message,
  PortalReceipt,
  Trade as KamidenTrade,
} from 'clients/kamiden/proto';
import { getTradeType } from 'app/cache/trade';
import { EntityID, EntityIndex } from 'engine/recs';
import { formatEntityID } from 'engine/utils';
import { auctions as explorerAuctions } from 'network/explorer/auctions';
import { calcPrice } from 'network/explorer/auctions/pricing';
import { quests as explorerQuests } from 'network/explorer/quests';
// upstream quirk: network/explorer/trades/index.ts is EMPTY (no exports);
// the explorer assembly imports ./trades/trades directly — so do we
import { trades as explorerTrades } from 'network/explorer/trades/trades';
import { getAccountByID, getAccountByIndex } from 'network/shapes/Account';
import { getItemByIndex } from 'network/shapes/Item';
import { getKamiByName, getKami as getShapeKami } from 'network/shapes/Kami';
import {
  canRepeatQuest,
  meetsObjectives,
  meetsRequirements,
  parseQuestObjectives,
  parseQuestRequirements,
} from 'network/shapes/Quest';
import type { Objective as QuestObjective } from 'network/shapes/Quest';
import { queryByIndex as queryKamiEntityByIndex } from 'network/shapes/Kami/queries';
import { getRoomByIndex } from 'network/shapes/Room';

import type { BufferedFeedEvent, FeedEventType, KamidenFeeds } from '../kamiden';
import { Mirror, QueryError } from './build';

// ------------------------------------------------------------- context

/** What a query builder gets to work with. Chain-only builders use just
 * the mirror; Kamiden-backed builders need the daemon's feed supervisor
 * and the chat policy from config. */
export type QueryCtx = {
  mirror: Mirror;
  kamiden?: KamidenFeeds;
  chat?: { enabled: boolean; maxBytes: number };
};

function requireKamiden(ctx: QueryCtx, what: string): KamidenFeeds {
  if (!ctx.kamiden) {
    throw new QueryError(
      'KAMIDEN_UNAVAILABLE',
      `${what} is kamiden-sourced and this daemon has no feed supervisor`
    );
  }
  return ctx.kamiden;
}

// ------------------------------------------------------ mirror joins

/** Kamiden id fields arrive as decimal strings; mirror requests want the
 * same value the web client sends: BigInt(id).toString() (e.g.
 * Trading.tsx getTradeHistory). */
function toDecimalId(id: string): string {
  return BigInt(id).toString();
}

export type IdRef = {
  /** the service's value, verbatim */
  id: string;
  index?: number;
  name?: string;
};

/** Resolve a Kamiden account id against the mirror: verbatim id plus
 * index/name when the entity resolves (the web client's join —
 * e.g. chat Feed.tsx renders account.name). Unresolvable ids stay bare. */
function accountIdRef(mirror: Mirror, rawId: string): IdRef {
  const ref: IdRef = { id: rawId };
  if (!rawId || rawId === '0') return ref;
  try {
    // upstream's own join (shapes/Account getByID: format, look up,
    // NullAccount when absent)
    const account = getAccountByID(mirror.world, mirror.components, rawId as EntityID);
    if (account.index) {
      ref.index = account.index;
      ref.name = account.name;
    }
  } catch {
    /* not an id — serve it bare */
  }
  return ref;
}

function kamiIdRef(mirror: Mirror, rawId: string): IdRef {
  const ref: IdRef = { id: rawId };
  if (!rawId || rawId === '0') return ref;
  try {
    const entity = mirror.world.entityToIndex.get(formatEntityID(rawId) as EntityID);
    if (entity === undefined) return ref;
    const kami = getShapeKami(mirror.world, mirror.components, entity);
    if (kami.index) ref.index = kami.index;
    if (kami.name) ref.name = kami.name;
  } catch {
    /* not an id — serve it bare */
  }
  return ref;
}

export type RoomRef = { index: number; name: string };

function roomRef(mirror: Mirror, index: number): RoomRef {
  try {
    const room = getRoomByIndex(mirror.world, mirror.components, index);
    return { index, name: room?.name ?? '' };
  } catch {
    return { index, name: '' }; // room index the mirror has no entity for
  }
}

export type ItemRef = { index: number; name: string };

function itemRef(mirror: Mirror, index: number): ItemRef {
  try {
    const item = getItemByIndex(mirror.world, mirror.components, index);
    return { index, name: item?.name ?? '' };
  } catch {
    return { index, name: '' }; // item index the mirror has no registry row for
  }
}

function accountByIndexOrThrow(mirror: Mirror, accountIndex: number) {
  const account = getAccountByIndex(mirror.world, mirror.components, accountIndex);
  if (!account.index) {
    throw new QueryError('NOT_FOUND', `account ${accountIndex} not in mirror`);
  }
  return account;
}

// ------------------------------------------------------------- battles

export type KillOut = {
  timestamp: number;
  roomIndex: number;
  room: RoomRef;
  isDeath: boolean;
  killer: IdRef;
  victim: IdRef;
  account: IdRef;
  killerHealth: { sync: number; total: number };
  victimHealth: { sync: number; total: number };
  bounty: string;
  salvage: string;
  spoils: string;
  blockNumber?: number;
};

export type BattlesOut = {
  kami: { id: string; index: number; name: string };
  before: number;
  stats?: { kills: number; deaths: number; pnl: number };
  kills: KillOut[];
};

function toKillOut(mirror: Mirror, kill: Kill): KillOut {
  return {
    timestamp: kill.Timestamp,
    roomIndex: kill.RoomIndex,
    room: roomRef(mirror, kill.RoomIndex),
    isDeath: kill.IsDeath,
    killer: kamiIdRef(mirror, kill.KillerId),
    victim: kamiIdRef(mirror, kill.VictimId),
    account: accountIdRef(mirror, kill.AccountID),
    killerHealth: { sync: kill.KillerHealthSync, total: kill.KillerHealthTotal },
    victimHealth: { sync: kill.VictimHealthSync, total: kill.VictimHealthTotal },
    bounty: kill.Bounty,
    salvage: kill.Salvage,
    spoils: kill.Spoils,
    ...(kill.BlockNumber !== undefined ? { blockNumber: kill.BlockNumber } : {}),
  };
}

/** Kami battles tab: GetBattleStats {KamiId} + GetBattles
 * {KillerId, VictimId, Timestamp} — the web client's requests verbatim
 * (Battles.tsx; app/cache/battles process()), one page per query,
 * backward from `before` (ms; default the corrected clock's now, exactly
 * upstream's first-page cursor). */
export async function battlesQuery(
  ctx: QueryCtx,
  args: { index: number; before?: number }
): Promise<BattlesOut> {
  const kamiden = requireKamiden(ctx, 'battles');
  const mirror = ctx.mirror;
  const entity = queryKamiEntityByIndex(mirror.world, mirror.components, args.index);
  if (entity === undefined) {
    throw new QueryError('NOT_FOUND', `kami ${args.index} not in mirror`);
  }
  const kami = getShapeKami(mirror.world, mirror.components, entity as EntityIndex);
  const kamiIdStr = toDecimalId(kami.id);
  const before = args.before ?? clock.now();

  const statsRes = await kamiden.unary('GetBattleStats', (c) =>
    c.getBattleStats({ KamiId: kamiIdStr })
  );
  const battlesRes = await kamiden.unary('GetBattles', (c) =>
    c.getBattles({ KillerId: kamiIdStr, VictimId: kamiIdStr, Timestamp: before })
  );

  return {
    kami: { id: kami.id, index: kami.index, name: kami.name },
    before,
    ...(statsRes.BattleStats
      ? {
          stats: {
            kills: statsRes.BattleStats.Kills,
            deaths: statsRes.BattleStats.Deaths,
            pnl: statsRes.BattleStats.PNL,
          },
        }
      : {}),
    kills: battlesRes.Kills.map((k) => toKillOut(mirror, k)),
  };
}

// -------------------------------------------------------------- trades

export type TradeOrderOut = { items: ItemRef[]; amounts: number[] };

export type TradeChainOut = {
  id: string;
  state: string;
  type: string;
  maker?: { index: number; name: string };
  taker?: { index: number; name: string };
  buyOrder?: TradeOrderOut;
  sellOrder?: TradeOrderOut;
};

export type TradeHistoryOut = {
  tradeId: string;
  maker: IdRef;
  taker: IdRef;
  buyOrder: { itemIndex: number; item: ItemRef; amount: string }[];
  sellOrder: { itemIndex: number; item: ItemRef; amount: string }[];
  timestamps: { create: string; cancel: string; execute: string; complete: string };
};

export type TradesOut = {
  open: TradeChainOut[];
  account?: { index: number; name: string };
  history?: TradeHistoryOut[];
  openOffers?: TradeHistoryOut[];
};

function toTradeHistoryOut(mirror: Mirror, t: KamidenTrade): TradeHistoryOut {
  return {
    tradeId: t.TradeId,
    maker: accountIdRef(mirror, t.MakerId),
    taker: accountIdRef(mirror, t.TakerId),
    buyOrder: t.BuyOrderIndices.map((itemIndex, i) => ({
      itemIndex,
      item: itemRef(mirror, itemIndex),
      amount: t.BuyOrderAmounts[i] ?? '',
    })),
    sellOrder: t.SellOrderIndices.map((itemIndex, i) => ({
      itemIndex,
      item: itemRef(mirror, itemIndex),
      amount: t.SellOrderAmounts[i] ?? '',
    })),
    timestamps: {
      create: t.CreateTimestamp,
      cancel: t.CancelTimestamp,
      execute: t.ExecuteTimestamp,
      complete: t.CompleteTimestamp,
    },
  };
}

/** Trading modal, designed whole (the M3 deferral record): chain-side
 * live trades via the ported explorer (state/type/orders — the mirror
 * truth), plus, when an account is named, the Kamiden history
 * (GetTradeHistory {AccountId, Timestamp: '0'} — Trading.tsx verbatim)
 * and the GetOpenOffers rows (same request type; defined at the pin but
 * uncalled by the web client — served because PORT_PLAN M4 names it,
 * observed semantics recorded by G4.a). */
export async function tradesQuery(
  ctx: QueryCtx,
  args: { accountIndex?: number }
): Promise<TradesOut> {
  const mirror = ctx.mirror;
  const explorer = explorerTrades(mirror.world, mirror.components);
  const open: TradeChainOut[] = explorer
    .all()
    .filter((t) => t.state === 'PENDING')
    .map((t) => ({
      id: t.id,
      state: t.state,
      type: getTradeType(t),
      ...(t.maker?.index ? { maker: { index: t.maker.index, name: t.maker.name } } : {}),
      ...(t.taker?.index ? { taker: { index: t.taker.index, name: t.taker.name } } : {}),
      // Number() coercion: the upstream TradeOrder type says number[], but
      // the mirror decodes these uint components as hex strings — the cast
      // is a phantom at the pin (vite never typechecks). Same quirk class
      // as the Trade Timestamp import (app/cache/trade/history.ts header).
      ...(t.buyOrder
        ? {
            buyOrder: {
              items: t.buyOrder.items.map((i) => ({ index: i.index, name: i.name })),
              amounts: (t.buyOrder.amounts ?? []).map(Number),
            },
          }
        : {}),
      ...(t.sellOrder
        ? {
            sellOrder: {
              items: t.sellOrder.items.map((i) => ({ index: i.index, name: i.name })),
              amounts: (t.sellOrder.amounts ?? []).map(Number),
            },
          }
        : {}),
    }));

  const out: TradesOut = { open };
  if (args.accountIndex !== undefined) {
    const account = accountByIndexOrThrow(mirror, args.accountIndex);
    out.account = { index: account.index, name: account.name };
    const kamiden = requireKamiden(ctx, 'trade history');
    const accountId = toDecimalId(account.id);
    const history = await kamiden.unary('GetTradeHistory', (c) =>
      c.getTradeHistory({ AccountId: accountId, Timestamp: '0' })
    );
    out.history = history.Trades.map((t) => toTradeHistoryOut(mirror, t));
    const offers = await kamiden.unary('GetOpenOffers', (c) =>
      c.getOpenOffers({ AccountId: accountId, Timestamp: '0' })
    );
    out.openOffers = offers.Trades.map((t) => toTradeHistoryOut(mirror, t));
  }
  return out;
}

// ------------------------------------------------------------ auctions

export type AuctionOut = {
  auctionItem?: ItemRef;
  paymentItem?: ItemRef;
  params: { value: number; period: number; decay: number; rate: number };
  supply: { sold: number; total: number };
  startTime: number;
  /** current price on the ported GDA curve (clock-corrected, §3.8) */
  price: number;
};

export type AuctionBuyOut = {
  accountIndex: string;
  itemIndex: number;
  amount: number;
  currency: number;
  cost: number;
  timestamp: number;
};

export type AuctionsOut = {
  auctions: AuctionOut[];
  buys?: AuctionBuyOut[];
};

/** Gacha auction surface, designed whole: chain auction state + current
 * GDA price via the ported explorer; with an item index, the price-chart
 * history via GetAuctionBuys {ItemIndex} (Chart.tsx verbatim, including
 * its ascending-timestamp sort). */
export async function auctionsQuery(
  ctx: QueryCtx,
  args: { itemIndex?: number }
): Promise<AuctionsOut> {
  const mirror = ctx.mirror;
  const explorer = explorerAuctions(mirror.world, mirror.components);
  const all = explorer.all();
  const rows: AuctionOut[] = all
    .filter((a) => a.auctionItem?.index)
    .map((a) => ({
      ...(a.auctionItem
        ? { auctionItem: { index: a.auctionItem.index, name: a.auctionItem.name } }
        : {}),
      ...(a.paymentItem
        ? { paymentItem: { index: a.paymentItem.index, name: a.paymentItem.name } }
        : {}),
      params: a.params,
      supply: a.supply,
      startTime: a.time.start,
      price: calcPrice(a, clock.now() / 1000, a.supply.sold),
    }));

  const out: AuctionsOut = { auctions: rows };
  if (args.itemIndex !== undefined) {
    const kamiden = requireKamiden(ctx, 'auction buy history');
    const res = await kamiden.unary('GetAuctionBuys', (c) =>
      c.getAuctionBuys({ ItemIndex: args.itemIndex })
    );
    out.buys = res.AuctionBuys.sort((a: AuctionBuy, b: AuctionBuy) => a.Timestamp - b.Timestamp).map(
      (b) => ({
        accountIndex: b.AccountIndex,
        itemIndex: b.ItemIndex,
        amount: b.Amount,
        currency: b.Currency,
        cost: b.Cost,
        timestamp: b.Timestamp,
      })
    );
  }
  return out;
}

// -------------------------------------------------------------- quests

export type QuestObjectiveOut = {
  name: string;
  /** what the objective counts, e.g. an item total or a reputation score */
  type: string;
  /** the raw handler/operator pair the world stores, e.g. INC_MIN */
  logic: string;
  /** the registry index the type is counted against, where it has one */
  index?: number;
  /** the threshold to reach; absent for objectives with no numeric target */
  required?: number;
  /** progress toward that threshold, on the basis named below; absent for
   * objectives with no numeric progress, and for a finished quest (whose
   * objectives stop being evaluated) */
  current?: number;
  met: boolean;
  /** how `current` is measured:
   *  · since-acceptance — accrual counted from the moment the quest was
   *    accepted, NOT a balance: spending what you accrued does not
   *    un-count it, and holding a balance from before acceptance does not
   *    count toward it;
   *  · current — the present value: a balance, a level, a score;
   *  · boolean — a condition that is met or not, with nothing to count;
   *  · unknown — a handler this version does not evaluate. */
  basis: 'since-acceptance' | 'current' | 'boolean' | 'unknown';
};

export type QuestAccountStateOut = {
  accepted: boolean;
  complete: boolean;
  requirementsMet: boolean;
  /** present only when accepted */
  objectivesMet?: boolean;
  /** present only for a finished repeatable quest: whether its cooldown
   * has elapsed */
  repeatAvailable?: boolean;
  /** instance times, present only when accepted */
  startTime?: number;
  endTime?: number;
  /** present only when accepted — see the pre-acceptance note on the
   * builder below */
  objectives?: QuestObjectiveOut[];
};

export type QuestRegistryOut = {
  index: number;
  name: string;
  description: string;
  repeatable: boolean;
  repeatDuration?: number;
  /** account-relative state (0.3.0), present on every registry row when the
   * query is given an account */
  account?: QuestAccountStateOut;
};

export type QuestAcceptedOut = {
  index: number;
  name: string;
  complete: boolean;
  startTime: number;
  endTime: number;
};

export type QuestsOut = {
  registry: QuestRegistryOut[];
  account?: { index: number; name: string };
  /** RETAINED, REDUNDANT: since 0.3.0 every registry row carries the same
   * acceptance facts (and more) in its `account` block. This list is kept
   * so that answers stay shape-compatible for consumers written against
   * earlier versions; new consumers should read the registry rows. */
  accepted?: QuestAcceptedOut[];
};

/** How `current` is measured, read off the handler the world stores. */
function objectiveBasis(logic: string): QuestObjectiveOut['basis'] {
  const handler = (logic ?? '').split('_')[0];
  if (handler === 'INC' || handler === 'DEC') return 'since-acceptance';
  if (handler === 'CURR') return 'current';
  if (handler === 'BOOL') return 'boolean';
  return 'unknown';
}

/** Number() coercion throughout: the mirror decodes some numeric components
 * as hex strings; the served surface is honest numbers. */
function toObjectiveOut(objective: QuestObjective): QuestObjectiveOut {
  const status = objective.status;
  return {
    name: objective.name,
    type: objective.target.type,
    logic: objective.logic,
    ...(objective.target.index !== undefined ? { index: Number(objective.target.index) } : {}),
    ...(status?.target !== undefined ? { required: Number(status.target) } : {}),
    ...(status?.current !== undefined ? { current: Number(status.current) } : {}),
    met: status?.completable ?? false,
    basis: objectiveBasis(objective.logic),
  };
}

/** Quests: the registry, and — given an account — where that account stands
 * on every quest in it, in one read.
 *
 * ACCOUNT-RELATIVE STATE is served as the facts that discriminate it rather
 * than as a single label: `accepted` and `complete` separate the three
 * states an account can be in on a quest (never accepted / accepted and
 * unfinished / already finished), and `objectivesMet` separates an
 * unfinished quest whose work is done from one whose work is not. The four
 * combinations are exhaustive and mutually exclusive, so any consumer
 * vocabulary maps onto them without loss:
 *   !accepted                              → never accepted
 *   accepted && complete                   → already finished
 *   accepted && !complete && objectivesMet → unfinished, work done
 *   accepted && !complete && !objectivesMet→ unfinished, work outstanding
 * `requirementsMet` answers, for a quest not yet accepted, whether it can
 * be accepted at all.
 *
 * The field is deliberately named `objectivesMet` and NOT "completable":
 * it is this layer's evaluation of the objectives it can read, not a
 * promise that submitting the finish transaction will succeed. A consumer
 * that needs that guarantee must ask the chain to simulate the act. Saying
 * "completable" here would be claiming knowledge this surface does not
 * have.
 *
 * PROGRESS IS SERVED FOR ACCEPTED QUESTS ONLY, and this is a correctness
 * requirement rather than a thrift. Accrual-type objectives count from a
 * snapshot taken when the quest is accepted; with no snapshot yet recorded
 * the comparison runs against zero, so an account's entire lifetime total
 * reads as if it were progress and an objective can appear satisfied before
 * the quest is even taken. (The game's own quest-detail panel renders that
 * artefact as a checkmark, which the accepted-quest counter then
 * contradicts once the quest is taken and the counter restarts at zero.)
 * Serving that number would hand a consumer a figure the world does not
 * hold. Unaccepted rows therefore carry the objective's type and threshold
 * and no progress at all. */
export function questsQuery(ctx: QueryCtx, args: { accountIndex?: number }): QuestsOut {
  const mirror = ctx.mirror;
  const { world, components } = mirror;
  const explorer = explorerQuests(world, components);
  const all = explorer.all().filter((q) => q.index);
  const toRegistryRow = (q: (typeof all)[number]): QuestRegistryOut => ({
    index: q.index,
    name: q.name,
    description: q.description,
    repeatable: q.repeatable,
    ...(q.repeatDuration ? { repeatDuration: Number(q.repeatDuration) } : {}),
  });

  if (args.accountIndex === undefined) return { registry: all.map(toRegistryRow) };

  const account = accountByIndexOrThrow(mirror, args.accountIndex);
  const accepted = explorer.getForAccount(args.accountIndex);
  const instances = new Map<number, (typeof accepted)[number]>();
  for (const instance of accepted) instances.set(instance.index, instance);

  const registry = all.map((q) => {
    const row = toRegistryRow(q);
    // requirements are account-relative conditions on the registry quest
    parseQuestRequirements(world, components, account, q);
    const state: QuestAccountStateOut = {
      accepted: instances.has(q.index),
      complete: false,
      requirementsMet: meetsRequirements(q),
    };
    const instance = instances.get(q.index);
    if (instance) {
      // objectives are evaluated on the INSTANCE: the acceptance snapshot
      // hangs off the instance entity, not the registry entry
      parseQuestObjectives(world, components, account, instance);
      state.complete = instance.complete;
      state.objectivesMet = meetsObjectives(instance);
      state.startTime = Number(instance.startTime);
      state.endTime = Number(instance.endTime);
      state.objectives = instance.objectives.map(toObjectiveOut);
      if (instance.complete && q.repeatable) state.repeatAvailable = canRepeatQuest(instance);
    }
    row.account = state;
    return row;
  });

  return {
    registry,
    account: { index: account.index, name: account.name },
    accepted: accepted.map((q) => ({
      index: q.index,
      name: q.name,
      complete: q.complete,
      startTime: Number(q.startTime),
      endTime: Number(q.endTime),
    })),
  };
}

// -------------------------------------------------------------- market

export type MarketListingOut = {
  orderId: string;
  seller: IdRef;
  buyer?: IdRef;
  kamiIndex: number;
  price: string;
  expiry: string;
  timestamp: number;
};

export type MarketBidOut = {
  orderId: string;
  buyer: IdRef;
  kamiIndex: number;
  total: number;
  price: string;
  expiry: string;
  timestamp: number;
  bidType: number;
  quantity: number;
  boughtKamiIndexes: number[];
};

export type MarketOrderOut = {
  timestamp: number;
  orderId: string;
  isCanceled: boolean;
  isComplete: boolean;
  listing?: MarketListingOut;
  bid?: MarketBidOut;
};

export type MarketOut = {
  listings: MarketListingOut[];
  bids: MarketBidOut[];
  account?: { index: number; name: string };
  orders?: MarketOrderOut[];
};

function toListingOut(mirror: Mirror, l: KamiMarketListing): MarketListingOut {
  return {
    orderId: l.OrderID,
    seller: accountIdRef(mirror, l.SellerAccountID),
    ...(l.BuyerAccountID ? { buyer: accountIdRef(mirror, l.BuyerAccountID) } : {}),
    kamiIndex: l.KamiIndex,
    price: l.Price,
    expiry: l.Expiry,
    timestamp: l.Timestamp,
  };
}

function toBidOut(mirror: Mirror, b: KamiMarketBid): MarketBidOut {
  return {
    orderId: b.OrderID,
    buyer: accountIdRef(mirror, b.BuyerAccountID),
    kamiIndex: b.KamiIndex,
    total: b.Total,
    price: b.Price,
    expiry: b.Expiry,
    timestamp: b.Timestamp,
    bidType: b.BidType,
    quantity: b.Quantity,
    boughtKamiIndexes: b.BoughtKamiIndexes,
  };
}

function toOrderOut(mirror: Mirror, o: KamiMarketOrder): MarketOrderOut {
  return {
    timestamp: o.Timestamp,
    orderId: o.OrderID,
    isCanceled: o.IsCanceled,
    isComplete: o.IsComplete,
    ...(o.Listing ? { listing: toListingOut(mirror, o.Listing) } : {}),
    ...(o.Bid ? { bid: toBidOut(mirror, o.Bid) } : {}),
  };
}

/** KamiSwap marketplace: GetKamiMarketListings/Bids {Size: 500}
 * (Listings.tsx/Bids.tsx verbatim); with an account, its order history
 * via GetKamiMarketHistory {AccountId, Timestamp: 0, Size: 500}
 * (MyOrders.tsx verbatim). */
export async function marketQuery(
  ctx: QueryCtx,
  args: { accountIndex?: number }
): Promise<MarketOut> {
  const kamiden = requireKamiden(ctx, 'market');
  const mirror = ctx.mirror;
  const listings = await kamiden.unary('GetKamiMarketListings', (c) =>
    c.getKamiMarketListings({ Size: 500 })
  );
  const bids = await kamiden.unary('GetKamiMarketBids', (c) => c.getKamiMarketBids({ Size: 500 }));

  const out: MarketOut = {
    listings: listings.Listings.map((l: KamiMarketListing) => toListingOut(mirror, l)),
    bids: bids.Bids.map((b: KamiMarketBid) => toBidOut(mirror, b)),
  };
  if (args.accountIndex !== undefined) {
    const account = accountByIndexOrThrow(mirror, args.accountIndex);
    out.account = { index: account.index, name: account.name };
    const history = await kamiden.unary('GetKamiMarketHistory', (c) =>
      c.getKamiMarketHistory({ AccountId: toDecimalId(account.id), Timestamp: 0, Size: 500 })
    );
    out.orders = (history.Orders ?? []).map((o: KamiMarketOrder) => toOrderOut(mirror, o));
  }
  return out;
}

// -------------------------------------------------------------- portal

export type ReceiptOut = {
  timestamp: string;
  account: IdRef;
  receiptId: string;
  item: ItemRef;
  itemAmt: string;
  taxAmt: string;
  tokenAddress: string;
  tokenAmt: string;
  isWithdrawal: boolean;
  isCanceled: boolean;
  isClaimed: boolean;
};

export type PortalOut = {
  account: { index: number; name: string };
  receipts: ReceiptOut[];
  openWithdrawals: ReceiptOut[];
};

function toReceiptOut(mirror: Mirror, r: PortalReceipt): ReceiptOut {
  return {
    timestamp: r.Timestamp,
    account: accountIdRef(mirror, r.AccountID),
    receiptId: r.ReceiptID,
    item: itemRef(mirror, r.ItemIndex),
    itemAmt: r.ItemAmt,
    taxAmt: r.TaxAmt,
    tokenAddress: r.TokenAddress,
    tokenAmt: r.TokenAmt,
    isWithdrawal: r.IsWithdrawal,
    isCanceled: r.IsCanceled,
    isClaimed: r.IsClaimed,
  };
}

/** Token portal history: the account's deposits + withdrawals
 * (GetTokenDeposits/GetTokenWithdrawals {AccountID}) and everyone else's
 * open withdrawals (GetOpenWithdrawals {AccountID: ''}, own rows filtered
 * out) — TokenPortal.tsx getTokenHistory verbatim, including the
 * concat order (withdrawals then deposits). */
export async function portalQuery(
  ctx: QueryCtx,
  args: { accountIndex: number }
): Promise<PortalOut> {
  const kamiden = requireKamiden(ctx, 'portal history');
  const mirror = ctx.mirror;
  const account = accountByIndexOrThrow(mirror, args.accountIndex);
  const accountId = toDecimalId(account.id);

  const withdrawals = await kamiden.unary('GetTokenWithdrawals', (c) =>
    c.getTokenWithdrawals({ AccountID: accountId })
  );
  const deposits = await kamiden.unary('GetTokenDeposits', (c) =>
    c.getTokenDeposits({ AccountID: accountId })
  );
  const open = await kamiden.unary('GetOpenWithdrawals', (c) =>
    c.getOpenWithdrawals({ AccountID: '' })
  );

  return {
    account: { index: account.index, name: account.name },
    receipts: (withdrawals.Receipts ?? [])
      .concat(deposits.Receipts ?? [])
      .map((r: PortalReceipt) => toReceiptOut(mirror, r)),
    openWithdrawals: (open.Receipts ?? [])
      .filter((r: PortalReceipt) => r.AccountID !== accountId)
      .map((r: PortalReceipt) => toReceiptOut(mirror, r)),
  };
}

// ----------------------------------------------------------- transfers

export type TransferOut = {
  sender: IdRef;
  recipient: IdRef;
  item: ItemRef;
  amount: string;
};

export type TransfersOut = {
  account: { index: number; name: string };
  transfers: TransferOut[];
};

/** Inventory transfer-history tab: GetItemTransfers {AccountID}
 * (Transfer.tsx verbatim; rows in service order — the web client reverses
 * for display, a UI choice not lifted into the data). */
export async function transfersQuery(
  ctx: QueryCtx,
  args: { accountIndex: number }
): Promise<TransfersOut> {
  const kamiden = requireKamiden(ctx, 'item transfers');
  const mirror = ctx.mirror;
  const account = accountByIndexOrThrow(mirror, args.accountIndex);
  const res = await kamiden.unary('GetItemTransfers', (c) =>
    c.getItemTransfers({ AccountID: toDecimalId(account.id) })
  );
  return {
    account: { index: account.index, name: account.name },
    transfers: (res.Transfers ?? []).map((t: ItemTransfer) => ({
      sender: accountIdRef(mirror, t.SenderAccountID),
      recipient: accountIdRef(mirror, t.RecvAccountID),
      item: itemRef(mirror, t.ItemIndex),
      amount: t.Amount,
    })),
  };
}

// ------------------------------------------------------------- killers

export type KillerRowOut = {
  rank: number;
  /** the service's kami name, verbatim (authored-id) */
  name: string;
  /** the service's Value string, verbatim */
  kills: string;
  /** mirror join by name (names are unique at the pin); absent when the
   * name no longer resolves — the verbatim row stands either way */
  kamiId?: string;
  kamiIndex?: number;
};

export type KillersOut = {
  /** every ranked row the service returned (rows is a size-capped slice —
   * the cap is the explicit size argument, never silent) */
  totalRanked: number;
  size: number;
  rows: KillerRowOut[];
};

/** Killer rankings (0.2.0): GetKillsByKami passthrough — the one
 * non-ApiKey-gated kami-level kills ranking the service exposes at the
 * pin (defined-but-uncalled by the web client, served with observed
 * semantics recorded by gate, the GetOpenOffers precedent). Rows arrive
 * ranked (kill count descending, server-defined all-time window — the
 * request takes no parameters); rank is the 1-based service position.
 * A time-windowed ranking is NOT servable without an API key at this pin:
 * GetKillerRanking is ApiKey-gated (empty-key calls answer empty),
 * GetBattles rejects id-less enumeration, and the mirror holds no kill
 * entities (IsKill is never registered) — recorded in coverage. */
export async function killersQuery(
  ctx: QueryCtx,
  args: { size?: number }
): Promise<KillersOut> {
  const kamiden = requireKamiden(ctx, 'killers');
  const mirror = ctx.mirror;
  const res = await kamiden.unary('GetKillsByKami', (c) => c.getKillsByKami({}));
  const ranked = res.Rows ?? [];
  const size = Math.max(0, args.size ?? 50);
  const rows: KillerRowOut[] = ranked.slice(0, size).map((r, i) => {
    const row: KillerRowOut = { rank: i + 1, name: r.Name, kills: r.Value };
    try {
      const match = getKamiByName(mirror.world, mirror.components, r.Name).find((k) => k.index);
      if (match) {
        row.kamiId = match.id;
        row.kamiIndex = match.index;
      }
    } catch {
      /* unresolvable name — serve the verbatim row bare */
    }
    return row;
  });
  return { totalRanked: ranked.length, size: rows.length, rows };
}

// ---------------------------------------------------------------- feed

export type FeedEntryOut = {
  seq: number;
  receivedAtWallMs: number;
  type: string;
  /** exactly one of the per-type payloads is present, keyed by type —
   * proto values verbatim; joined refs added where the web client's feed
   * pane renders a name (movements, harvest ends, kills) */
  movement?: { accountId: string; account: IdRef; room: RoomRef; timestamp: number };
  harvestEnd?: { kamiId: string; kami: IdRef; room: RoomRef; timestamp: number };
  kill?: KillOut;
  trade?: TradeHistoryOut;
  kamiCast?: {
    accountId: string;
    account: IdRef;
    targetId: string;
    target: IdRef;
    itemIndex: number;
    nodeIndex: number;
    timestamp: number;
  };
  droptableReveal?: {
    commitId: string;
    holderId: string;
    dtId: string;
    timestamp: number;
    itemIndices: number[];
    itemAmounts: string[];
  };
  sacrificeReveal?: {
    commitId: string;
    holderId: string;
    kamiId: string;
    dtId: string;
    timestamp: number;
    itemIndices: number[];
    itemAmounts: string[];
  };
  kamiMarketList?: {
    orderId: string;
    accountId: string;
    kamiIndex: number;
    price: string;
    expiry: string;
    timestamp: number;
  };
  kamiMarketBuy?: {
    orderId: string;
    buyerAccountId: string;
    sellerAccountId: string;
    kamiIndex: number;
    price: string;
    timestamp: number;
  };
  kamiMarketOffer?: {
    orderId: string;
    accountId: string;
    kamiIndex: number;
    quantity: number;
    price: string;
    expiry: string;
    timestamp: number;
  };
  kamiMarketAccept?: {
    orderId: string;
    sellerAccountId: string;
    buyerAccountId: string;
    kamiIndex: number;
    price: string;
    timestamp: number;
  };
  kamiMarketCancel?: { orderId: string; accountId: string; timestamp: number };
};

export type FeedOut = {
  stream: {
    state: string;
    topics: string[];
    silentMs: number;
    retries: number;
    lastError: string | null;
    framesReceived: number;
    feedFrames: number;
    messagesDropped: number;
  };
  buffer: { size: number; capacity: number; evicted: number; newestSeq: number };
  events: FeedEntryOut[];
};

const FEED_TYPES: FeedEventType[] = [
  'movement',
  'harvestEnd',
  'kill',
  'trade',
  'kamiCast',
  'droptableReveal',
  'sacrificeReveal',
  'kamiMarketList',
  'kamiMarketBuy',
  'kamiMarketOffer',
  'kamiMarketAccept',
  'kamiMarketCancel',
];

function toFeedEntryOut(mirror: Mirror, entry: BufferedFeedEvent): FeedEntryOut {
  const base: FeedEntryOut = {
    seq: entry.seq,
    receivedAtWallMs: entry.receivedAtWallMs,
    type: entry.type,
  };
  const e = entry.event as never;
  switch (entry.type) {
    case 'movement': {
      const m = e as { RoomIndex: number; AccountId: string; Timestamp: number };
      base.movement = {
        accountId: m.AccountId,
        account: accountIdRef(mirror, m.AccountId),
        room: roomRef(mirror, m.RoomIndex),
        timestamp: m.Timestamp,
      };
      break;
    }
    case 'harvestEnd': {
      const h = e as { RoomIndex: number; KamiId: string; Timestamp: number };
      base.harvestEnd = {
        kamiId: h.KamiId,
        kami: kamiIdRef(mirror, h.KamiId),
        room: roomRef(mirror, h.RoomIndex),
        timestamp: h.Timestamp,
      };
      break;
    }
    case 'kill':
      base.kill = toKillOut(mirror, e as Kill);
      break;
    case 'trade':
      base.trade = toTradeHistoryOut(mirror, e as KamidenTrade);
      break;
    case 'kamiCast': {
      const c = e as {
        AccountID: string;
        Timestamp: number;
        TargetID: string;
        itemIndex: number;
        nodeIndex: number;
      };
      base.kamiCast = {
        accountId: c.AccountID,
        account: accountIdRef(mirror, c.AccountID),
        targetId: c.TargetID,
        target: kamiIdRef(mirror, c.TargetID),
        itemIndex: c.itemIndex,
        nodeIndex: c.nodeIndex,
        timestamp: c.Timestamp,
      };
      break;
    }
    case 'droptableReveal': {
      const d = e as {
        CommitID: string;
        HolderID: string;
        DtID: string;
        Timestamp: number;
        ItemIndices: number[];
        ItemAmounts: string[];
      };
      base.droptableReveal = {
        commitId: d.CommitID,
        holderId: d.HolderID,
        dtId: d.DtID,
        timestamp: d.Timestamp,
        itemIndices: d.ItemIndices,
        itemAmounts: d.ItemAmounts,
      };
      break;
    }
    case 'sacrificeReveal': {
      const s = e as {
        CommitID: string;
        HolderID: string;
        KamiID: string;
        DtID: string;
        Timestamp: number;
        ItemIndices: number[];
        ItemAmounts: string[];
      };
      base.sacrificeReveal = {
        commitId: s.CommitID,
        holderId: s.HolderID,
        kamiId: s.KamiID,
        dtId: s.DtID,
        timestamp: s.Timestamp,
        itemIndices: s.ItemIndices,
        itemAmounts: s.ItemAmounts,
      };
      break;
    }
    case 'kamiMarketList': {
      const l = e as {
        OrderID: string;
        AccountID: string;
        KamiIndex: number;
        Price: string;
        Expiry: string;
        Timestamp: number;
      };
      base.kamiMarketList = {
        orderId: l.OrderID,
        accountId: l.AccountID,
        kamiIndex: l.KamiIndex,
        price: l.Price,
        expiry: l.Expiry,
        timestamp: l.Timestamp,
      };
      break;
    }
    case 'kamiMarketBuy': {
      const b = e as {
        OrderID: string;
        BuyerAccountID: string;
        SellerAccountID: string;
        KamiIndex: number;
        Price: string;
        Timestamp: number;
      };
      base.kamiMarketBuy = {
        orderId: b.OrderID,
        buyerAccountId: b.BuyerAccountID,
        sellerAccountId: b.SellerAccountID,
        kamiIndex: b.KamiIndex,
        price: b.Price,
        timestamp: b.Timestamp,
      };
      break;
    }
    case 'kamiMarketOffer': {
      const o = e as {
        OrderID: string;
        AccountID: string;
        KamiIndex: number;
        Quantity: number;
        Price: string;
        Expiry: string;
        Timestamp: number;
      };
      base.kamiMarketOffer = {
        orderId: o.OrderID,
        accountId: o.AccountID,
        kamiIndex: o.KamiIndex,
        quantity: o.Quantity,
        price: o.Price,
        expiry: o.Expiry,
        timestamp: o.Timestamp,
      };
      break;
    }
    case 'kamiMarketAccept': {
      const a = e as {
        OrderID: string;
        SellerAccountID: string;
        BuyerAccountID: string;
        KamiIndex: number;
        Price: string;
        Timestamp: number;
      };
      base.kamiMarketAccept = {
        orderId: a.OrderID,
        sellerAccountId: a.SellerAccountID,
        buyerAccountId: a.BuyerAccountID,
        kamiIndex: a.KamiIndex,
        price: a.Price,
        timestamp: a.Timestamp,
      };
      break;
    }
    case 'kamiMarketCancel': {
      const c = e as { OrderID: string; AccountID: string; Timestamp: number };
      base.kamiMarketCancel = {
        orderId: c.OrderID,
        accountId: c.AccountID,
        timestamp: c.Timestamp,
      };
      break;
    }
  }
  return base;
}

/** The battle/kill feed row (coverage): the daemon's bounded ring buffer
 * over stream Feed events, served as a pull query. Buffer state and
 * stream health ride along so a degraded stream is visible in the answer
 * itself, not just in status (§3.2). */
export function feedQuery(
  ctx: QueryCtx,
  args: { sinceSeq?: number; type?: string }
): FeedOut {
  const kamiden = requireKamiden(ctx, 'feed');
  if (args.type !== undefined && !FEED_TYPES.includes(args.type as FeedEventType)) {
    throw new QueryError('BAD_ARGS', `unknown feed type '${args.type}' (have: ${FEED_TYPES.join(', ')})`);
  }
  const status = kamiden.getStatus();
  const events = kamiden.read({
    sinceSeq: args.sinceSeq,
    type: args.type as FeedEventType | undefined,
  });
  return {
    stream: {
      state: status.stream.state,
      topics: status.stream.topics,
      silentMs: status.stream.silentMs,
      retries: status.stream.retries,
      lastError: status.stream.lastError,
      framesReceived: status.stream.framesReceived,
      feedFrames: status.stream.feedFrames,
      messagesDropped: status.stream.messagesDropped,
    },
    buffer: status.buffer,
    events: events.map((entry) => toFeedEntryOut(ctx.mirror, entry)),
  };
}

// ---------------------------------------------------------------- chat

export type ChatMessageOut = {
  roomIndex: number;
  account: IdRef;
  timestamp: number;
  /** verbatim body — absent when withheld (never truncated, §3.10) */
  message?: string;
  /** oversize receipt: present exactly when message was withheld */
  withheld?: { reason: 'oversize'; bytes: number };
};

export type ChatOut = {
  roomIndex: number;
  before: number;
  count: number;
  messages: ChatMessageOut[];
};

/** The §3.10 chat plan (gate G4.c): dedicated paginated GetRoomMessages
 * passthrough {RoomIndex, Timestamp, Size?} — the web client's request
 * (chat.ts process(): backward from the cursor; default cursor = the
 * corrected clock's now, exactly upstream's first page). Bodies are
 * verbatim and envelope-tagged authored-prose (the dedicated query is the
 * §3.10 opt-in); a body over ctx.chat.maxBytes is withheld with an
 * explicit receipt unless the oversize flag asks for it verbatim. The
 * kill-switch (chatEnabled=false) removes the query with the documented
 * CHAT_DISABLED code. */
export async function chatQuery(
  ctx: QueryCtx,
  args: { roomIndex: number; before?: number; size?: number; oversize?: boolean }
): Promise<ChatOut> {
  if (!ctx.chat?.enabled) {
    throw new QueryError('CHAT_DISABLED', 'the chat query is disabled by config (DESIGN §3.10 kill-switch)');
  }
  const kamiden = requireKamiden(ctx, 'chat');
  const before = args.before ?? clock.now();
  const res = await kamiden.unary('GetRoomMessages', (c) =>
    c.getRoomMessages({
      RoomIndex: args.roomIndex,
      Timestamp: before,
      ...(args.size !== undefined ? { Size: args.size } : {}),
    })
  );
  const maxBytes = ctx.chat.maxBytes;
  const messages: ChatMessageOut[] = (res.Messages ?? []).map((m: Message) => {
    const bytes = Buffer.byteLength(m.Message, 'utf8');
    const oversize = bytes > maxBytes && !args.oversize;
    return {
      roomIndex: m.RoomIndex,
      account: accountIdRef(ctx.mirror, m.AccountId),
      timestamp: m.Timestamp,
      ...(oversize ? { withheld: { reason: 'oversize' as const, bytes } } : { message: m.Message }),
    };
  });
  return { roomIndex: args.roomIndex, before, count: messages.length, messages };
}
