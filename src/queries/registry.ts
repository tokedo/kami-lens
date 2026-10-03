// kami-lens native module (not a port): the query registry (DESIGN §4.3).
// One entry per served query: argument parsing (shared by CLI and socket),
// the checked-in output schema, and the builder. The same registry backs
// the daemon socket, the CLI, and the library exports — "the same queries
// as library exports" is a table property, not a promise.
//
// M4: builders take a QueryCtx ({mirror, kamiden?, chat?}) and may be
// async (Kamiden unary passthroughs). 0.4.0 adds `enrich` to that context —
// the §3.12 payload-enrichment flag, threaded here rather than read from a
// module global so a library caller passing a bare Mirror gets the flag-off
// surface by construction. Chain-only builders keep using just
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
  skillsQuery,
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
  FEED_LIMIT_DEFAULT,
  FEED_LIMIT_MAX,
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
  | 'chat'
  | 'skills';

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
  /** the `--flags` this query accepts as ARGUMENTS — parsed by `parseArgs`
   * alongside the positionals, never by the envelope. DECLARING THEM HERE IS
   * LOAD-BEARING (§3.13): the CLI used to carry a hand-written allowlist of
   * three flag spellings and silently dropped every `--flag` outside it, so a
   * new argument, or a typo of an existing one, produced a DIFFERENT ANSWER
   * with no error at all. The CLI now routes exactly what a query declares
   * and refuses anything else. */
  args?: string[];
  /** 1.0.0: the subset of `args` that take a VALUE (`--limit 50` or
   * `--limit=50`). Only these accept the inline `=` form — a boolean flag
   * written `--full=1` stays an unknown option rather than being silently
   * read as absent. */
  valued?: string[];
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

/** 1.0.0: take one declared VALUED option out of the tokens — `--flag <v>`
 * or `--flag=<v>`. Given twice, or with no value after it, is BAD_ARGS (a
 * second value silently winning would be the §3.13 silent-argument defect). */
export function takeValued(
  tokens: readonly string[],
  flag: string
): { value: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  let seen = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    let raw: string | undefined;
    if (t === flag) {
      raw = tokens[i + 1];
      if (raw === undefined || raw.startsWith('--')) {
        throw new QueryError('BAD_ARGS', `${flag} needs a value`);
      }
      i++;
    } else if (t.startsWith(flag + '=')) {
      raw = t.slice(flag.length + 1);
      if (raw === '') throw new QueryError('BAD_ARGS', `${flag} needs a value`);
    } else {
      rest.push(t);
      continue;
    }
    if (seen) throw new QueryError('BAD_ARGS', `${flag} given twice`);
    seen = true;
    value = raw;
  }
  return { value, rest };
}


export const REGISTRY: Record<QueryName, QueryDef> = {
  kami: {
    name: 'kami',
    summary: 'single-kami vitals by on-chain index (--stats adds the kami sheet\'s stat block + affinities)',
    args: ['--stats'],
    parseArgs: (positional) => {
      const [index] = positional.filter((p) => p !== '--stats');
      return { index: int(index, 'kami index'), stats: positional.includes('--stats') };
    },
    stateless: true,
    kamiden: false,
    build: (ctx, a) => kamiQuery(ctx.mirror, a as { index: number; stats?: boolean }),
  },
  account: {
    name: 'account',
    operatorArg: true,
    summary:
      'account by index, name or 0x-address (bio only with --prose; gas balance when an RPC is configured; --slim serves identity with no roster and no chain read)',
    args: ['--slim'],
    parseArgs: (positional) => {
      // FILTER THE FLAGS FIRST (0.5.2). This read `([key]) => …`, taking
      // argv[0] verbatim — the one query-argument parser that did not, because
      // until now `account` declared no arguments. The moment it declares one,
      // `account --slim` with no positional would take '--slim' itself as the
      // lookup key and answer NOT_FOUND on a name nobody asked about. The
      // §3.13 silent-argument defect, one release later, in the other
      // direction.
      const [key] = positional.filter((p) => !p.startsWith('--'));
      const slim = positional.includes('--slim');
      if (key === undefined) {
        throw new QueryError('BAD_ARGS', 'account needs an index, a name or an address');
      }
      // §3.14: an address is a third lookup key. Without this an address went
      // down the NAME path, matched nothing, and answered NOT_FOUND — which a
      // reader cannot tell from "this account does not exist".
      if (/^0x[0-9a-fA-F]{40}$/.test(key)) return { address: key, slim };
      return /^\d+$/.test(key) ? { index: Number(key), slim } : { name: key, slim };
    },
    stateless: false,
    kamiden: false,
    build: (ctx, a, o) =>
      accountQuery(
        ctx.mirror,
        a as { index?: number; name?: string; address?: string; slim?: boolean },
        o,
        ctx.enrich,
        ctx.rpc
      ),
  },
  node: {
    name: 'node',
    summary:
      'node with its ACTIVE harvests; --with-vitals [attackerKamiIndex] adds occupant vitals + liquidation preview, plus attacker.blocked (the attacker\'s own gate: null, ATTACKER_STARVING or ATTACKER_COOLDOWN) (--full lifts the row cap, --stats adds the stat block, --eligible-only serves the rows whose target is in reach — threshold > 0 and margin > 0 — regardless of the attacker\'s own state, so an empty list means no target in reach and never "my kami is starving")',
    args: ['--with-vitals', '--full', '--stats', '--eligible-only'],
    parseArgs: (positional) => {
      const rest = positional.filter((p) => !p.startsWith('--'));
      const withVitals = positional.includes('--with-vitals');
      const [index, attacker] = rest;
      if (attacker !== undefined && !withVitals) {
        throw new QueryError('BAD_ARGS', 'an attacker kami argument needs --with-vitals');
      }
      // the stat block hangs off the occupant VITALS; without --with-vitals
      // there is nothing for it to hang off, and silently ignoring the flag
      // would be the §3.13 silent-argument defect all over again
      if (positional.includes('--stats') && !withVitals) {
        throw new QueryError('BAD_ARGS', '--stats needs --with-vitals');
      }
      // §3.13 (0.5.2): the filter reads the liquidation preview, which only
      // exists on a vitals answer that was given an attacker. Refuse both
      // ways rather than serve an unfiltered answer to a caller who asked
      // for a filtered one — the §3.13 silent-argument rule. (0.5.3 moved
      // the predicate to the TARGET side — `threshold > 0 && margin > 0` —
      // but it is still a per-pairing preview, so both refusals stand.)
      const eligibleOnly = positional.includes('--eligible-only');
      if (eligibleOnly && !withVitals) {
        throw new QueryError('BAD_ARGS', '--eligible-only needs --with-vitals');
      }
      if (eligibleOnly && attacker === undefined) {
        throw new QueryError(
          'BAD_ARGS',
          '--eligible-only needs an attacker kami argument (eligibility is a pairing, not a property)'
        );
      }
      return {
        index: int(index, 'node index'),
        withVitals,
        attacker: optInt(attacker, 'attacker kami index'),
        full: positional.includes('--full'),
        stats: positional.includes('--stats'),
        eligibleOnly,
      };
    },
    stateless: false,
    kamiden: false,
    build: (ctx, a) =>
      nodeQuery(
        ctx.mirror,
        a as {
          index: number;
          withVitals?: boolean;
          attacker?: number;
          full?: boolean;
          stats?: boolean;
          eligibleOnly?: boolean;
        },
        ctx.enrich
      ),
  },
  party: {
    name: 'party',
    operatorArg: true,
    summary:
      'account party report: kamis with full vitals (--full lifts the row cap, --stats adds the kami sheet\'s stat block + affinities)',
    args: ['--full', '--stats'],
    parseArgs: (positional) => {
      const [accountIndex] = positional.filter((p) => !p.startsWith('--'));
      return {
        accountIndex: int(accountIndex, 'account index'),
        full: positional.includes('--full'),
        stats: positional.includes('--stats'),
      };
    },
    stateless: false,
    kamiden: false,
    build: (ctx, a) =>
      partyQuery(ctx.mirror, a as { accountIndex: number; full?: boolean; stats?: boolean }),
  },
  roster: {
    name: 'roster',
    operatorArg: true,
    summary:
      'compact roster: one line per kami (index, state, hp) + where the account is (--stats adds the stat block and CAPS the list)',
    args: ['--stats'],
    parseArgs: (positional) => {
      const [accountIndex] = positional.filter((p) => p !== '--stats');
      return {
        accountIndex: int(accountIndex, 'account index'),
        stats: positional.includes('--stats'),
      };
    },
    stateless: false,
    kamiden: false,
    build: (ctx, a) =>
      rosterQuery(ctx.mirror, a as { accountIndex: number; stats?: boolean }, ctx.enrich),
  },
  item: {
    name: 'item',
    summary: 'item registry row by index',
    parseArgs: ([index]) => ({ index: int(index, 'item index') }),
    stateless: false,
    kamiden: false,
    build: (ctx, a) => itemQuery(ctx.mirror, a as { index: number }, ctx.enrich),
  },
  items: {
    name: 'items',
    summary: 'the item registry, compact ([type] filters; --full serves whole rows)',
    args: ['--full'],
    parseArgs: (positional) => {
      const [type] = positional.filter((p) => p !== '--full');
      return { type, full: positional.includes('--full') };
    },
    stateless: false,
    kamiden: false,
    build: (ctx, a) =>
      itemsQuery(ctx.mirror, a as { type?: string; full?: boolean }, ctx.enrich),
  },
  skills: {
    name: 'skills',
    summary: 'skill registry; with [kamiIndex], that kami\'s unspent points + taken skills',
    parseArgs: ([kamiIndex]) => ({ kamiIndex: optInt(kamiIndex, 'kami index') }),
    stateless: false,
    kamiden: false,
    build: (ctx, a) => skillsQuery(ctx.mirror, a as { kamiIndex?: number }, ctx.enrich),
  },
  config: {
    name: 'config',
    summary: 'one is.config field value (--array for packed arrays)',
    args: ['--array'],
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
    build: (ctx, a) =>
      inventoryQuery(ctx.mirror, a as { index?: number; name?: string }, ctx.enrich),
  },
  room: {
    name: 'room',
    summary: 'room: its exits, and the accounts currently in it (--full lifts the occupant cap)',
    args: ['--full'],
    parseArgs: (positional) => {
      const [index] = positional.filter((p) => p !== '--full');
      return { index: int(index, 'room index'), full: positional.includes('--full') };
    },
    stateless: false,
    kamiden: false,
    build: (ctx, a) => roomQuery(ctx.mirror, a as { index: number; full?: boolean }),
  },
  merchant: {
    name: 'merchant',
    summary: 'NPC merchants; with [npcIndex], the listing catalog with prices (--full serves whole rows)',
    args: ['--full'],
    parseArgs: (positional) => {
      const [index] = positional.filter((p) => p !== '--full');
      return { index: optInt(index, 'npc index'), full: positional.includes('--full') };
    },
    stateless: false,
    kamiden: false,
    build: (ctx, a) =>
      merchantQuery(ctx.mirror, a as { index?: number; full?: boolean }, ctx.enrich),
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
    summary:
      'mirror Score leaderboard ([type] [epoch] [itemIndex]; defaults COLLECT 1 1; --full lifts the row cap)',
    args: ['--full'],
    parseArgs: (positional) => {
      const [type, epoch, itemIndex] = positional.filter((p) => p !== '--full');
      return {
        type: type ?? 'COLLECT',
        epoch: optInt(epoch, 'epoch') ?? 1,
        itemIndex: optInt(itemIndex, 'item index') ?? 1,
        full: positional.includes('--full'),
      };
    },
    stateless: false,
    kamiden: false,
    build: (ctx, a) =>
      leaderboardQuery(
        ctx.mirror,
        a as { type: string; epoch: number; itemIndex: number; full?: boolean }
      ),
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
    summary:
      'open chain trades; with [accountIndex], kamiden history + open offers (--full lifts the row cap)',
    args: ['--full'],
    parseArgs: (positional) => {
      const [accountIndex] = positional.filter((p) => p !== '--full');
      return {
        accountIndex: optInt(accountIndex, 'account index'),
        full: positional.includes('--full'),
      };
    },
    stateless: false,
    kamiden: false, // chain listing works without kamiden; history needs it
    build: (ctx, a) => tradesQuery(ctx, a as { accountIndex?: number; full?: boolean }),
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
    summary:
      'quests, compact ([accountIndex] [questIndex] keys one; --open / --accepted narrow; --full serves the whole registry)',
    args: ['--full', '--open', '--accepted'],
    parseArgs: (positional) => {
      const rest = positional.filter((p) => !p.startsWith('--'));
      const open = positional.includes('--open');
      const acceptedOnly = positional.includes('--accepted');
      if (open && acceptedOnly) {
        throw new QueryError('BAD_ARGS', '--open and --accepted are alternatives, not a pair');
      }
      const [accountIndex, questIndex] = rest;
      return {
        accountIndex: optInt(accountIndex, 'account index'),
        questIndex: optInt(questIndex, 'quest index'),
        view: open ? 'open' : acceptedOnly ? 'accepted' : undefined,
        full: positional.includes('--full'),
      };
    },
    stateless: false,
    kamiden: false,
    build: (ctx, a) =>
      questsQuery(
        ctx,
        a as {
          accountIndex?: number;
          questIndex?: number;
          view?: 'open' | 'accepted';
          full?: boolean;
        }
      ),
  },
  market: {
    name: 'market',
    operatorArg: true,
    summary:
      'KamiSwap listings + bids (kamiden); with [accountIndex], order history (--full lifts the row caps)',
    args: ['--full'],
    parseArgs: (positional) => {
      const [accountIndex] = positional.filter((p) => p !== '--full');
      return {
        accountIndex: optInt(accountIndex, 'account index'),
        full: positional.includes('--full'),
      };
    },
    stateless: false,
    kamiden: true,
    build: (ctx, a) => marketQuery(ctx, a as { accountIndex?: number; full?: boolean }),
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
    summary:
      'buffered stream feed events: without [sinceSeq] the NEWEST --limit (default 50, max 500) in ascending seq; with it, the events after it, oldest first, capped at --limit ([type] filters; --account <accountIndex> keeps events naming that account or a kami it owns now)',
    args: ['--limit', '--account'],
    valued: ['--limit', '--account'],
    parseArgs: (positional) => {
      const { value: limitRaw, rest: r1 } = takeValued(positional, '--limit');
      const { value: accountRaw, rest } = takeValued(r1, '--account');
      const args: { sinceSeq?: number; type?: string; limit: number; accountIndex?: number } = {
        limit: FEED_LIMIT_DEFAULT,
      };
      for (const p of rest) {
        if (/^\d+$/.test(p)) {
          // 1.0.0 (B1): a second numeric used to overwrite the first —
          // `feed 120 50` meant "since 50", silently
          if (args.sinceSeq !== undefined) {
            throw new QueryError(
              'BAD_ARGS',
              `feed takes one numeric (sinceSeq), got '${args.sinceSeq}' and '${p}' — the row cap is --limit <n>`
            );
          }
          args.sinceSeq = int(p, 'sinceSeq');
        } else {
          if (args.type !== undefined) {
            throw new QueryError('BAD_ARGS', `feed takes one type filter, got '${args.type}' and '${p}'`);
          }
          args.type = p;
        }
      }
      if (limitRaw !== undefined) {
        const n = /^\d+$/.test(limitRaw) ? Number(limitRaw) : NaN;
        if (!Number.isInteger(n) || n < 1 || n > FEED_LIMIT_MAX) {
          throw new QueryError('BAD_ARGS', `--limit must be an integer from 1 to ${FEED_LIMIT_MAX}, got '${limitRaw}'`);
        }
        args.limit = n;
      }
      if (accountRaw !== undefined) args.accountIndex = int(accountRaw, '--account');
      return args;
    },
    stateless: false,
    kamiden: true,
    build: (ctx, a) =>
      feedQuery(ctx, a as { sinceSeq?: number; type?: string; limit?: number; accountIndex?: number }),
  },
  chat: {
    name: 'chat',
    summary: 'room chat page (kamiden; [beforeMs] [size]; --oversize serves withheld bodies)',
    args: ['--oversize'],
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

// ------------------------------------------- §3.13 argument routing (0.5.2)
//
// ONE MODULE OWNS THE RULE, because the two entry points disagreed and the
// disagreement was silent. 0.5.0 fixed the CLI: a query declares its argument
// vocabulary and an undeclared option is a usage error rather than a
// different answer. The SOCKET was never given the same treatment, and it is
// the path the harness and the agents actually use — so `account 3379
// --slim` came back with the whole roster and `node … --eligible-only` came
// back unfiltered, both with `ok: true` and no error at all, while the CLI
// refused the same tokens outright. A wrong-but-plausible answer to a caller
// who asked for something else is the exact defect class §3.13 exists to
// refuse; that it survived on the busier path for a release is the reason
// the routing now lives in one place instead of two.

/** Flags the CLI itself consumes, valid on every query. On the SOCKET these
 * are request FIELDS (`prose`, `noAuthored`, `oversize`), not argument
 * tokens — which is the one respect in which the two vocabularies differ,
 * and the refusal message says so by listing what the calling path takes. */
export const CLIENT_FLAGS: readonly string[] = ['--prose', '--no-authored', '--stateless'];

// ------------------------------------------ 1.0.0 (A5) read-your-writes

/** The two VALUED options every world read accepts (1.0.0, A5). They are not
 * per-query arguments — they decide WHEN the read is served, not what it
 * answers — so they are taken off the token list here, before the per-query
 * vocabulary is checked, on both entry points. */
export const AT_LEAST = '--at-least';
export const MAX_WAIT = '--max-wait';
export const MAX_WAIT_DEFAULT_MS = 5_000;
export const MAX_WAIT_CAP_MS = 30_000;

export type Freshness = { atLeast?: number; maxWaitMs: number };

/** Split `--at-least <block>` / `--max-wait <ms>` (also the `--opt=value`
 * form) out of a query's tokens. BAD_ARGS on a malformed value, on a
 * `--max-wait` without `--at-least`, on a wait above the cap, and on either
 * option against `status` (it is not a world read). */
export function takeFreshnessArgs(
  query: string,
  tokens: readonly string[]
): { args: string[]; freshness: Freshness } {
  const args: string[] = [];
  let atLeast: number | undefined;
  let maxWait: number | undefined;
  const parse = (name: string, raw: string | undefined, max?: number): number => {
    const n = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(n)) {
      throw new QueryError('BAD_ARGS', `${name} needs a non-negative integer, got '${raw ?? ''}'`);
    }
    if (max !== undefined && n > max) {
      throw new QueryError('BAD_ARGS', `${name} is capped at ${max} (got ${n})`);
    }
    return n;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const [flag, inline] = t.includes('=') ? [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)] : [t, undefined];
    if (flag === AT_LEAST || flag === MAX_WAIT) {
      const raw = inline ?? tokens[++i];
      if (flag === AT_LEAST) atLeast = parse(AT_LEAST, raw);
      else maxWait = parse(MAX_WAIT, raw, MAX_WAIT_CAP_MS);
      continue;
    }
    args.push(t);
  }
  if ((atLeast !== undefined || maxWait !== undefined) && query === 'status') {
    throw new QueryError('BAD_ARGS', `${AT_LEAST} / ${MAX_WAIT} apply to world reads, not to 'status'`);
  }
  if (maxWait !== undefined && atLeast === undefined) {
    throw new QueryError('BAD_ARGS', `${MAX_WAIT} needs ${AT_LEAST} <block>`);
  }
  return { args, freshness: { atLeast, maxWaitMs: maxWait ?? MAX_WAIT_DEFAULT_MS } };
}

/** The `--flags` a query declares as ARGUMENTS. */
export function declaredArgs(query: string): readonly string[] {
  return REGISTRY[query as QueryName]?.args ?? [];
}

/** `status` is served by the daemon rather than the registry, but it is a
 * real query name and takes no arguments. */
function isKnownQuery(query: string): boolean {
  return query === 'status' || query in REGISTRY;
}

function unknownOption(query: string, arg: string, accepts: readonly string[]): QueryError {
  const list = [...accepts].sort();
  return new QueryError(
    'BAD_ARGS',
    `unknown option '${arg}' for '${query}' — accepts: ${list.length > 0 ? list.join(', ') : '(no options)'}`
  );
}

/** SOCKET routing (0.5.2): refuse any `--`-prefixed token the query does not
 * declare. An unknown QUERY name is left alone so the caller gets the
 * unknown-query error rather than a complaint about the flags of a query
 * that does not exist — the same precedence the CLI uses. */
export function assertSocketArgs(query: string, args: readonly string[]): void {
  if (!isKnownQuery(query)) return;
  const accepts = declaredArgs(query);
  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    if (accepts.includes(arg)) continue;
    if (isInlineValued(query, arg)) continue;
    throw unknownOption(query, arg, accepts);
  }
}

/** `--flag=value` for a declared VALUED option (1.0.0) */
function isInlineValued(query: string, arg: string): boolean {
  const eq = arg.indexOf('=');
  if (eq < 0) return false;
  return (REGISTRY[query as QueryName]?.valued ?? []).includes(arg.slice(0, eq));
}

/** CLI routing (0.5.0; moved here at 0.5.2 so one module owns the rule).
 * Query arguments ride through as positionals for the query's own parseArgs;
 * client flags are separated out; anything else is a usage error. Throws the
 * same QueryError the socket path throws, so the two refusals are the same
 * refusal. */
export function routeCliArgs(
  command: string,
  remaining: readonly string[]
): { positional: string[]; flags: Set<string> } {
  const declared = declaredArgs(command);
  const known = isKnownQuery(command);
  const positional: string[] = [];
  const flags = new Set<string>();
  // 1.0.0 (A5): the valued freshness options are validated here (the same
  // function the socket uses) and ride through to the daemon verbatim
  const { args: rest, freshness } = takeFreshnessArgs(command, remaining);
  if (freshness.atLeast !== undefined) {
    positional.push(AT_LEAST, String(freshness.atLeast), MAX_WAIT, String(freshness.maxWaitMs));
  }
  for (const arg of rest) {
    if (!arg.startsWith('--')) positional.push(arg);
    else if (declared.includes(arg) || isInlineValued(command, arg)) positional.push(arg);
    else if (CLIENT_FLAGS.includes(arg)) flags.add(arg);
    else if (!known) flags.add(arg);
    else throw unknownOption(command, arg, [...declared, ...CLIENT_FLAGS]);
  }
  return { positional, flags };
}

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
