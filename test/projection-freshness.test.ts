// A1 — an answer never looks complete when it is not.
//
// The projection caches in app/cache/* stamp each sub-object with the time it
// was refreshed and skip a refresh whose window has not elapsed. The windows
// are the forced-refresh -1 s of build.ts (KAMI_REFRESH), so in principle
// every read refreshes everything. But the stamps are taken on the PROJECTION
// clock (clock.now(): wall time plus an offset re-anchored every 300 s on the
// header time of the last streamed block), and that clock steps BACKWARDS
// whenever the anchor block is older than the previous anchor implied — a
// stream stall is the live case: the re-anchor pins now() to the frozen
// block's header time. Every stamp taken before the step is then "in the
// future", `updateDelta > -1` is false, and the sub-object is skipped.
//
// The builders clear KamiCache before each read to force freshness, so a
// skipped sub-object is not "stale" — it is ABSENT on the rebuilt kami: no
// stats (hp 0/0), no progress (no level), no time, no harvest (no node, no
// musu). Config is the one sub-object that survives, because the live world
// has no KAMI_REST_RECOVERY field and the ported isFalsey guard therefore
// never stamps the config block; so assertKamiConfigUsable passes and the
// hollow answer is served as a healthy one.
//
// These tests drive the real projection over a synthetic mirror and step the
// real clock exactly the way daemon.ts syncClock does.

import { beforeEach, describe, expect, it } from 'vitest';

import * as clock from 'clock';
import { buildKamiVitals, nodeQuery } from '../src/queries/build';
import { addKami, makeMirror } from './support/mirror';

const nowSec = () => Math.floor(Date.now() / 1000);

/** What syncClock does on every tick: anchor the clock on a block header. */
const anchor = (blockTimestampSec: number, block = 1_000) =>
  clock.observeBlockTimestamp(blockTimestampSec, block);

beforeEach(() => {
  clock.reset();
});

describe('A1: a backward clock step must not hollow out a projected kami', () => {
  it('kami: stats, level and node survive a re-anchor 120 s into the past', () => {
    const m = makeMirror();
    const t = nowSec();
    const e = addKami(m, { index: 101, state: 'HARVESTING', node: 7, lastTime: t - 600 });

    anchor(t); // a healthy anchor
    const before = buildKamiVitals(m, e);
    expect(before.hp.total).toBe(100);
    expect(before.level).toBe(12);
    expect(before.node?.index).toBe(7);

    // the stream stalled; the next syncClock re-observes the frozen block,
    // whose header is 120 s old, and now() steps back by that much
    anchor(t - 120);
    const after = buildKamiVitals(m, e);

    // the same kami, the same mirror, nothing written in between
    expect.soft(after.state).toBe('HARVESTING');
    expect.soft(after.hp.total).toBe(100);
    expect.soft(after.level).toBe(12);
    expect.soft(after.node?.index).toBe(7);
  });

  it('node --with-vitals: an occupant row keeps its vitals across the step', () => {
    const m = makeMirror();
    const t = nowSec();
    addKami(m, { index: 201, state: 'HARVESTING', node: 9, lastTime: t - 600 });

    anchor(t);
    const before = nodeQuery(m, { index: 9, withVitals: true });
    expect(before.harvests[0]!.vitals!.hp.total).toBe(100);

    anchor(t - 120);
    const after = nodeQuery(m, { index: 9, withVitals: true });
    expect.soft(after.harvests[0]!.vitals!.hp.total).toBe(100);
    expect.soft(after.harvests[0]!.vitals!.level).toBe(12);
  });

  it('node <attacker>: a healthy attacker does not read as starving after the step', () => {
    const m = makeMirror();
    const t = nowSec();
    addKami(m, { index: 301, state: 'HARVESTING', node: 11, lastTime: t - 600 });
    addKami(m, { index: 302, state: 'HARVESTING', node: 11, lastTime: t - 600 });

    anchor(t);
    const before = nodeQuery(m, { index: 11, withVitals: true, attacker: 302 });
    expect(before.attacker!.blocked).toBeNull();

    anchor(t - 120);
    const after = nodeQuery(m, { index: 11, withVitals: true, attacker: 302 });
    expect(after.attacker!.blocked).toBeNull();
  });
});
