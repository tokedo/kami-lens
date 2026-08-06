// kami-lens native module (not a port): the query registry (DESIGN §4.3).
// One entry per served query: argument parsing (shared by CLI and socket),
// the checked-in output schema, and the builder. The same registry backs
// the daemon socket, the CLI, and the library exports — "the same queries
// as library exports" is a table property, not a promise.
//
// M4: builders take a QueryCtx ({mirror, kamiden?, chat?}) and may be
// async (Kamiden unary passthroughs). Chain-only builders keep using just
// ctx.mirror. The chat entry is subject to the §3.10 kill-switch, enforced
// inside its builder (CHAT_DISABLED) so the removal is an explicit,
// documented answer rather than a silent absence.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  accountQuery,
  configQuery,
  inventoryQuery,
  itemQuery,
  itemsQuery,
  kamiQuery,
  leaderboardQuery,
  merchantQuery,
  nodeQuery,
  partyQuery,
  phaseQuery,
  QueryError,
  roomQuery,
  rosterQuery,
} from './build';
import { EnvelopeOptions, QuerySchema } from './envelope';
import {
  auctionsQuery,
  battlesQuery,
  chatQuery,
  feedQuery,
  killersQuery,
  marketQuery,
  portalQuery,
  QueryCtx,
  questsQuery,
  tradesQuery,
  transfersQuery,
} from './feeds';

export type QueryName =
  | 'kami'
  | 'account'
  | 'node'
  | 'party'
  | 'roster'
  | 'item'
  | 'items'
  | 'config'
  | 'inventory'
  | 'room'
  | 'merchant'
  | 'phase'
  | 'leaderboard'
  | 'killers'
  | 'battles'
  | 'trades'
  | 'auctions'
  | 'quests'
  | 'market'
  | 'portal'
  | 'transfers'
  | 'feed'
  | 'chat';

export type QueryDef = {
  name: QueryName;
  summary: string;
  /** positional CLI args → builder args; throws QueryError on bad input */
  parseArgs: (positional: string[]) => Record<string, unknown>;
  /** true when the query is servable without a daemon (G3.d) */
  stateless: boolean;
  /** true when the answer needs the Kamiden feed service (soft dependency,
   * §3.2 — an outage degrades exactly these, with KAMIDEN_UNAVAILABLE) */
  kamiden: boolean;
  /** §3.10: invoking this dedicated query IS the authored-prose opt-in
   * (chat) — the envelope keeps prose fields without the --prose flag */
  forcesProse?: boolean;
  /** first positional is an account index eligible for the configured
   * defaultOperator prefill when omitted (DESIGN §5 — never a special
   * path, just a prefilled argument) */
  operatorArg?: boolean;
  build: (
    ctx: QueryCtx,
    args: Record<string, unknown>,
    opts: EnvelopeOptions & { oversize?: boolean }
  ) => unknown | Promise<unknown>;
};

const int = (s: string | undefined, what: string): number => {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) throw new QueryError('BAD_ARGS', `${what} must be a non-negative integer`);
  return n;
};

const optInt = (s: string | undefined, what: string): number | undefined =>
  s === undefined ? undefined : int(s, what);

export const REGISTRY: Record<QueryName, QueryDef> = {
  kami: {
    name: 'kami',
    summary: 'single-kami vitals by on-chain index',
    parseArgs: ([index]) => ({ index: int(index, 'kami index') }),
    stateless: true,
    kamiden: false,
    build: (ctx, a) => kamiQuery(ctx.mirror, a as { index: number }),
  },
  account: {
    name: 'account',
    operatorArg: true,
    summary: 'account by index or name (bio only with --prose)',
    parseArgs: ([key]) => {
      if (key === undefined) throw new QueryError('BAD_ARGS', 'account needs an index or name');
      return /^\d+$/.test(key) ? { index: Number(key) } : { name: key };
    },
    stateless: false,
    kamiden: false,
    build: (ctx, a, o) => accountQuery(ctx.mirror, a as { index?: number; name?: string }, o),
  },
  node: {
    name: 'node',
    summary:
      'node with its ACTIVE harvests; --with-vitals [attackerKamiIndex] adds occupant vitals + liquidation preview',
    parseArgs: (positional) => {
      const rest = positional.filter((p) => p !== '--with-vitals');
      const withVitals = rest.length !== positional.length;
      const [index, attacker] = rest;
      if (attacker !== undefined && !withVitals) {
        throw new QueryError('BAD_ARGS', 'an attacker kami argument needs --with-vitals');
      }
      return {
        index: int(index, 'node index'),
        withVitals,
        attacker: optInt(attacker, 'attacker kami index'),
      };
    },
    stateless: false,
    kamiden: false,
    build: (ctx, a) =>
      nodeQuery(ctx.mirror, a as { index: number; withVitals?: boolean; attacker?: number }),
  },
  party: {
    name: 'party',
    operatorArg: true,
    summary: 'account party report: every kami with full vitals',
    parseArgs: ([accountIndex]) => ({ accountIndex: int(accountIndex, 'account index') }),
    stateless: false,
    kamiden: false,
    build: (ctx, a) => partyQuery(ctx.mirror, a as { accountIndex: number }),
  },
  roster: {
    name: 'roster',
    operatorArg: true,
    summary: 'compact roster: one line per kami (index, state, hp) + where the account is',
    parseArgs: ([accountIndex]) => ({ accountIndex: int(accountIndex, 'account index') }),
    stateless: false,
    kamiden: false,
    build: (ctx, a) => rosterQuery(ctx.mirror, a as { accountIndex: number }),
  },
  item: {
    name: 'item',
    summary: 'item registry row by index',
    parseArgs: ([index]) => ({ index: int(index, 'item index') }),
    stateless: false,
    kamiden: false,
    build: (ctx, a) => itemQuery(ctx.mirror, a as { index: number }),
  },
  items: {
    name: 'items',
    summary: 'the full item registry',
    parseArgs: () => ({}),
    stateless: false,
    kamiden: false,
    build: (ctx) => itemsQuery(ctx.mirror),
  },
  config: {
    name: 'config',
    summary: 'one is.config field value (--array for packed arrays)',
    parseArgs: ([name, flag]) => {
      if (!name) throw new QueryError('BAD_ARGS', 'config needs a field name');
      return { name, array: flag === '--array' };
    },
    stateless: false,
    kamiden: false,
    build: (ctx, a) => configQuery(ctx.mirror, a as { name: string; array?: boolean }),
  },
  inventory: {
    name: 'inventory',
    operatorArg: true,
    summary: 'any-account item inventory by index or name',
    parseArgs: ([key]) => {
      if (key === undefined) throw new QueryError('BAD_ARGS', 'inventory needs an account index or name');
      return /^\d+$/.test(key) ? { index: Number(key) } : { name: key };
    },
    stateless: false,
    kamiden: false,
    build: (ctx, a) => inventoryQuery(ctx.mirror, a as { index?: number; name?: string }),
  },
  room: {
    name: 'room',
    summary: 'room occupancy: accounts (and their kamis) currently in the room',
    parseArgs: ([index]) => ({ index: int(index, 'room index') }),
    stateless: false,
    kamiden: false,
    build: (ctx, a) => roomQuery(ctx.mirror, a as { index: number }),
  },
  merchant: {
    name: 'merchant',
    summary: 'NPC merchants; with [npcIndex], the full listing catalog with prices',
    parseArgs: ([index]) => ({ index: optInt(index, 'npc index') }),
    stateless: false,
    kamiden: false,
    build: (ctx, a) => merchantQuery(ctx.mirror, a as { index?: number }),
  },
  phase: {
    name: 'phase',
    summary: 'world day/night phase (36-hour cycle) + seconds to the next flip',
    parseArgs: () => ({}),
    stateless: false,
    kamiden: false,
    build: () => phaseQuery(),
  },
  leaderboard: {
    name: 'leaderboard',
    summary: "mirror Score leaderboard ([type] [epoch] [itemIndex]; defaults COLLECT 1 1)",
    parseArgs: ([type, epoch, itemIndex]) => ({
      type: type ?? 'COLLECT',
      epoch: optInt(epoch, 'epoch') ?? 1,
      itemIndex: optInt(itemIndex, 'item index') ?? 1,
    }),
    stateless: false,
    kamiden: false,
    build: (ctx, a) =>
      leaderboardQuery(ctx.mirror, a as { type: string; epoch: number; itemIndex: number }),
  },
  killers: {
    name: 'killers',
    summary: 'killer rankings: kamis by kills, service order ([size], default 50; kamiden)',
    parseArgs: ([size]) => ({ size: optInt(size, 'size') }),
    stateless: false,
    kamiden: true,
    build: (ctx, a) => killersQuery(ctx, a as { size?: number }),
  },
  battles: {
    name: 'battles',
    summary: 'kami battle history + stats (kamiden; [beforeMs] pages back)',
    parseArgs: ([index, before]) => ({
      index: int(index, 'kami index'),
      before: optInt(before, 'before (ms timestamp)'),
    }),
    stateless: false,
    kamiden: true,
    build: (ctx, a) => battlesQuery(ctx, a as { index: number; before?: number }),
  },
  trades: {
    name: 'trades',
    operatorArg: true,
    summary: 'open chain trades; with [accountIndex], kamiden history + open offers',
    parseArgs: ([accountIndex]) => ({
      accountIndex: optInt(accountIndex, 'account index'),
    }),
    stateless: false,
    kamiden: false, // chain listing works without kamiden; history needs it
    build: (ctx, a) => tradesQuery(ctx, a as { accountIndex?: number }),
  },
  auctions: {
    name: 'auctions',
    summary: 'chain auctions with current GDA price; with [itemIndex], kamiden buy history',
    parseArgs: ([itemIndex]) => ({ itemIndex: optInt(itemIndex, 'item index') }),
    stateless: false,
    kamiden: false, // chain listing works without kamiden; buys need it
    build: (ctx, a) => auctionsQuery(ctx, a as { itemIndex?: number }),
  },
  quests: {
    name: 'quests',
    operatorArg: true,
    summary: 'quest registry; with [accountIndex], accepted quests + completion',
    parseArgs: ([accountIndex]) => ({
      accountIndex: optInt(accountIndex, 'account index'),
    }),
    stateless: false,
    kamiden: false,
    build: (ctx, a) => questsQuery(ctx, a as { accountIndex?: number }),
  },
  market: {
    name: 'market',
    operatorArg: true,
    summary: 'KamiSwap listings + bids (kamiden); with [accountIndex], order history',
    parseArgs: ([accountIndex]) => ({
      accountIndex: optInt(accountIndex, 'account index'),
    }),
    stateless: false,
    kamiden: true,
    build: (ctx, a) => marketQuery(ctx, a as { accountIndex?: number }),
  },
  portal: {
    name: 'portal',
    operatorArg: true,
    summary: 'token portal history for an account + open withdrawals (kamiden)',
    parseArgs: ([accountIndex]) => ({ accountIndex: int(accountIndex, 'account index') }),
    stateless: false,
    kamiden: true,
    build: (ctx, a) => portalQuery(ctx, a as { accountIndex: number }),
  },
  transfers: {
    name: 'transfers',
    operatorArg: true,
    summary: 'item transfer history for an account (kamiden)',
    parseArgs: ([accountIndex]) => ({ accountIndex: int(accountIndex, 'account index') }),
    stateless: false,
    kamiden: true,
    build: (ctx, a) => transfersQuery(ctx, a as { accountIndex: number }),
  },
  feed: {
    name: 'feed',
    summary: 'buffered stream feed events ([sinceSeq] [type] filter)',
    parseArgs: (positional) => {
      const args: { sinceSeq?: number; type?: string } = {};
      for (const p of positional) {
        if (/^\d+$/.test(p)) args.sinceSeq = int(p, 'sinceSeq');
        else args.type = p;
      }
      return args;
    },
    stateless: false,
    kamiden: true,
    build: (ctx, a) => feedQuery(ctx, a as { sinceSeq?: number; type?: string }),
  },
  chat: {
    name: 'chat',
    summary: 'room chat page (kamiden; [beforeMs] [size]; --oversize serves withheld bodies)',
    parseArgs: (positional) => {
      const rest = positional.filter((p) => p !== '--oversize');
      const oversize = rest.length !== positional.length;
      const [roomIndex, before, size] = rest;
      return {
        roomIndex: int(roomIndex, 'room index'),
        before: optInt(before, 'before (ms timestamp)'),
        size: optInt(size, 'size'),
        oversize,
      };
    },
    stateless: false,
    kamiden: true,
    forcesProse: true,
    build: (ctx, a, o) =>
      chatQuery(ctx, {
        ...(a as { roomIndex: number; before?: number; size?: number; oversize?: boolean }),
        oversize: (a as { oversize?: boolean }).oversize || o.oversize,
      }),
  },
};

const SCHEMA_DIR = path.resolve(import.meta.dirname, 'schemas');
const schemaCache = new Map<string, QuerySchema>();

/** The checked-in output schema for a query (status included — it is served
 * by the daemon rather than built from the mirror, but its contract is
 * checked the same way). */
export function loadSchema(name: QueryName | 'status'): QuerySchema {
  let s = schemaCache.get(name);
  if (!s) {
    s = JSON.parse(readFileSync(path.join(SCHEMA_DIR, `${name}.json`), 'utf8')) as QuerySchema;
    schemaCache.set(name, s);
  }
  return s;
}

export const QUERY_NAMES = Object.keys(REGISTRY) as QueryName[];
