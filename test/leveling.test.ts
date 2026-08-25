// 0.5.0 (§3.13) — the leveling loop's derived parts, on synthetic kamis.
// The chain requires BOTH conditions (KamiLevelSystem: verifyState RESTING,
// then experience >= calcLevelCost), and the reference client renders that
// two contradictory ways: the party card's arrow checks experience alone
// (KamiCard.tsx), the kami bar checks experience AND resting (KamiBar.tsx).
// These pin the strict reading and the tooltip's own blocker precedence.

import { describe, expect, it } from 'vitest';

import { capRows, LIST_CAP } from '../src/queries/build';

// SCOPE, stated rather than implied: `levelingOf` reads the next-level
// requirement through the ported curve, which reads is.config off a real
// mirror — so what is unit-tested here is the DECISION the block encodes,
// re-stated once and pinned against the chain's own precondition. The wired
// numbers are asserted over a real mirror, and far more of them than a unit
// test could carry: G7.a recomputes the roster's leveling sets against the
// party report over 1,050 kamis, G6.a compares the kami query against the
// node's occupant rows field for field, and G3.f asserts every one of these
// fields is actually present on the base surface.
describe('level-up readiness (§3.13)', () => {
  const decide = (xp: number, xpRequired: number, state: string) => {
    const enough = xp >= xpRequired;
    const resting = state === 'RESTING';
    const ready = enough && resting;
    return {
      levelUpReady: ready,
      ...(ready ? {} : { levelUpBlockedBy: !enough ? 'EXPERIENCE' : 'NOT_RESTING' }),
    };
  };

  it('requires BOTH enough experience and resting — the chain precondition', () => {
    expect(decide(100, 100, 'RESTING').levelUpReady).toBe(true);
    expect(decide(101, 100, 'RESTING').levelUpReady).toBe(true);
    expect(decide(99, 100, 'RESTING').levelUpReady).toBe(false);
    // the case the party card's arrow gets wrong: enough experience, harvesting
    expect(decide(500, 100, 'HARVESTING').levelUpReady).toBe(false);
    expect(decide(500, 100, 'DEAD').levelUpReady).toBe(false);
  });

  it('names the blocker in the reference tooltip precedence — experience first', () => {
    // both fail: the tooltip reports experience, and so do we
    expect(decide(0, 100, 'HARVESTING').levelUpBlockedBy).toBe('EXPERIENCE');
    expect(decide(0, 100, 'RESTING').levelUpBlockedBy).toBe('EXPERIENCE');
    expect(decide(500, 100, 'HARVESTING').levelUpBlockedBy).toBe('NOT_RESTING');
  });

  it('never names a blocker on a ready kami', () => {
    expect(decide(100, 100, 'RESTING').levelUpBlockedBy).toBeUndefined();
  });

  it('treats the boundary as ready — the chain compares with >=, not >', () => {
    // KamiLevelSystem reverts only when experience < levelCost, so exactly
    // enough experience IS enough; an off-by-one here would tell a reader it
    // cannot take an act the chain would accept
    expect(decide(40, 40, 'RESTING').levelUpReady).toBe(true);
    expect(decide(39, 40, 'RESTING').levelUpReady).toBe(false);
  });
});

describe('capRows (§3.13)', () => {
  const rows = Array.from({ length: 137 }, (_, i) => i);

  it('caps at LIST_CAP and reports the true total', () => {
    const { served, total } = capRows(rows, false);
    expect(total).toBe(137);
    expect(served.length).toBe(LIST_CAP);
    // the served rows are the PREFIX: order is unconditional, so a capped
    // answer and a --full answer agree about which rows come first
    expect(served).toEqual(rows.slice(0, LIST_CAP));
  });

  it('--full lifts the cap without changing the total', () => {
    const { served, total } = capRows(rows, true);
    expect(total).toBe(137);
    expect(served.length).toBe(137);
  });

  it('a list under the cap is served whole, and still reports its total', () => {
    const short = [1, 2, 3];
    expect(capRows(short, false)).toEqual({ served: short, total: 3 });
  });

  it('an empty list is a legal answer, never an omission', () => {
    expect(capRows([], false)).toEqual({ served: [], total: 0 });
  });
});
