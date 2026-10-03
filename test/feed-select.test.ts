// 1.0.0 (B1): the `feed` query — newest N by default, --limit, --account, and a
// second numeric refused.
//
// Through 0.6.3 `feed` took no account or limit, read every numeric as
// sinceSeq (so `feed 120 50` silently meant "since 50") and returned the
// OLDEST 500 buffered events — on a full 4,096-event buffer, the stalest
// eighth of it. These pin the new selection, the counts that say whether the
// answer was cut, and the refusals.

import { describe, expect, it } from 'vitest';

import { setComponent } from 'engine/recs';
import { hashArgs } from 'network/shapes/utils';
import { KamidenFeeds } from '../src/kamiden';
import { FEED_LIMIT_DEFAULT, feedAccountMatcher } from '../src/queries/feeds';
import { assertSocketArgs, REGISTRY, routeCliArgs } from '../src/queries/registry';
import { QueryError } from '../src/queries/build';
import { addKami, makeMirror } from './support/mirror';

const emptyFeed = {
  Movements: [],
  HarvestEnds: [],
  Kills: [],
  Trades: [],
  KamiCasts: [],
  DroptableReveals: [],
  SacrificeReveals: [],
  KamiMarketLists: [],
  KamiMarketBuys: [],
  KamiMarketOffers: [],
  KamiMarketAccepts: [],
  KamiMarketCancels: [],
};
const move = (n: number, account = String(n)) => ({
  RoomIndex: n,
  AccountId: account,
  Timestamp: n,
});

function feedsWith(n: number, capacity = 4096): KamidenFeeds {
  const feeds = new KamidenFeeds({ url: undefined, bufferCapacity: capacity });
  for (let i = 1; i <= n; i++) {
    feeds.ingestForTest({
      Messages: [],
      Feed: { ...emptyFeed, Movements: [move(i, String(i % 3))] },
    });
  }
  return feeds;
}

describe('KamidenFeeds.select (B1)', () => {
  it('without a cursor: the NEWEST `limit`, ascending, with the true match count', () => {
    const feeds = feedsWith(120);
    const { events, matched } = feeds.select({ limit: 50 });
    expect(matched).toBe(120);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 71 + i));
  });

  it('with a cursor: the events after it, OLDEST first, capped', () => {
    const feeds = feedsWith(120);
    const { events, matched } = feeds.select({ sinceSeq: 10, limit: 50 });
    expect(matched).toBe(110); // everything after the cursor, before the cap
    expect(events[0]!.seq).toBe(11);
    expect(events.at(-1)!.seq).toBe(60);
  });

  it('a cursor at 0 is a cursor (oldest first), not the default', () => {
    const feeds = feedsWith(5);
    expect(feeds.select({ sinceSeq: 0, limit: 2 }).events.map((e) => e.seq)).toEqual([1, 2]);
    expect(feeds.select({ limit: 2 }).events.map((e) => e.seq)).toEqual([4, 5]);
  });

  it('the predicate filters before the cap and the count', () => {
    const feeds = feedsWith(30);
    const { events, matched } = feeds.select({
      limit: 4,
      match: (e) => (e.event as { AccountId: string }).AccountId === '0',
    });
    expect(matched).toBe(10); // seq 3, 6, …, 30
    expect(events.map((e) => e.seq)).toEqual([21, 24, 27, 30]);
  });

  it('fewer matches than the limit: all of them, served == matched', () => {
    const feeds = feedsWith(3);
    const { events, matched } = feeds.select({ limit: 50 });
    expect(matched).toBe(3);
    expect(events).toHaveLength(3);
  });
});

describe('feed argument parsing (B1)', () => {
  const parse = (args: string[]) => REGISTRY.feed.parseArgs(args);
  const bad = (args: string[]) => {
    try {
      parse(args);
    } catch (e) {
      return (e as QueryError).code;
    }
    return 'accepted';
  };

  it('defaults to a limit of 50 and no cursor', () => {
    expect(FEED_LIMIT_DEFAULT).toBe(50);
    expect(parse([])).toEqual({ limit: 50 });
  });

  it('one numeric is the cursor, one word is the type', () => {
    expect(parse(['120', 'kill'])).toEqual({
      limit: 50,
      sinceSeq: 120,
      type: 'kill',
    });
  });

  it('a SECOND numeric is refused (it used to overwrite the first)', () => {
    expect(bad(['120', '50'])).toBe('BAD_ARGS');
  });

  it('a second type is refused', () => {
    expect(bad(['kill', 'movement'])).toBe('BAD_ARGS');
  });

  it('--limit takes 1..500, in both spellings, once', () => {
    expect(parse(['--limit', '1']).limit).toBe(1);
    expect(parse(['--limit=500']).limit).toBe(500);
    expect(bad(['--limit', '0'])).toBe('BAD_ARGS');
    expect(bad(['--limit', '501'])).toBe('BAD_ARGS');
    expect(bad(['--limit', 'x'])).toBe('BAD_ARGS');
    expect(bad(['--limit'])).toBe('BAD_ARGS');
    expect(bad(['--limit', '5', '--limit', '6'])).toBe('BAD_ARGS');
  });

  it('--account takes a non-negative integer', () => {
    expect(parse(['--account', '3379']).accountIndex).toBe(3379);
    expect(bad(['--account', 'bob'])).toBe('BAD_ARGS');
  });

  it('the routing accepts the inline form for VALUED options only', () => {
    expect(() => assertSocketArgs('feed', ['--limit=5'])).not.toThrow();
    expect(() => assertSocketArgs('node', ['--full=1'])).toThrow(QueryError);
    expect(routeCliArgs('feed', ['--limit=5', 'kill']).positional).toEqual(['--limit=5', 'kill']);
  });
});

describe('feed --account matching (B1)', () => {
  function mirrorWithAccount() {
    const m = makeMirror();
    const accId = hashArgs(['account', 77], ['string', 'uint32']);
    const acc = m.world.registerEntity({ id: accId });
    setComponent(m.components.EntityType, acc, { value: 'ACCOUNT' });
    setComponent(m.components.AccountIndex, acc, { value: 77 });
    setComponent(m.components.Name, acc, { value: 'alice' });
    const kami = addKami(m, { index: 501, state: 'RESTING', lastTime: 1 });
    setComponent(m.components.OwnsKamiID, kami, { value: accId });
    const kamiId = m.world.entities[kami]!;
    return {
      m,
      accDec: BigInt(accId).toString(),
      kamiDec: BigInt(kamiId).toString(),
    };
  }
  const entry = (type: string, event: object) =>
    ({ seq: 1, receivedAtWallMs: 0, type, event }) as never;

  it('matches the account fields and the kamis it owns now, in decimal or hex', () => {
    const { m, accDec, kamiDec } = mirrorWithAccount();
    const match = feedAccountMatcher(m, 77);
    expect(match(entry('movement', { AccountId: accDec }))).toBe(true);
    expect(match(entry('movement', { AccountId: '0x' + BigInt(accDec).toString(16) }))).toBe(true);
    expect(match(entry('movement', { AccountId: '12345' }))).toBe(false);
    expect(match(entry('harvestEnd', { KamiId: kamiDec }))).toBe(true);
    expect(match(entry('kill', { AccountID: '1', KillerId: '2', VictimId: kamiDec }))).toBe(true);
    expect(match(entry('kill', { AccountID: '1', KillerId: '2', VictimId: '3' }))).toBe(false);
    expect(match(entry('trade', { MakerId: '9', TakerId: accDec }))).toBe(true);
    expect(match(entry('kamiCast', { AccountID: '9', TargetID: kamiDec }))).toBe(true);
    expect(match(entry('droptableReveal', { HolderID: accDec }))).toBe(true);
    expect(match(entry('sacrificeReveal', { HolderID: '9', KamiID: kamiDec }))).toBe(true);
    expect(match(entry('kamiMarketList', { AccountID: '9', KamiIndex: 501 }))).toBe(true);
    expect(
      match(
        entry('kamiMarketBuy', {
          BuyerAccountID: '9',
          SellerAccountID: accDec,
          KamiIndex: 1,
        })
      )
    ).toBe(true);
    expect(match(entry('kamiMarketCancel', { AccountID: accDec }))).toBe(true);
    expect(match(entry('kamiMarketCancel', { AccountID: '0' }))).toBe(false);
  });

  it('an account not in the mirror is NOT_FOUND, not an empty feed', () => {
    const { m } = mirrorWithAccount();
    expect(() => feedAccountMatcher(m, 999)).toThrow(/not in mirror/);
  });
});
