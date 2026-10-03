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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as clock from 'clock';
import { setComponent } from 'engine/recs';
import { hashArgs } from 'network/shapes/utils';
import { buildKamiVitals, nodeQuery } from '../src/queries/build';
import { addKami, addNode, makeMirror } from './support/mirror';

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

// The harvest cache (app/cache/harvest/base.ts) keeps one harvest object per
// harvest entity for the life of the process — the builders never clear it —
// and refreshes its `node` only when the node stamp is older than 2 s. That
// stamp was on the same backward-stepping clock. A harvest entity is one per
// kami and is REUSED across harvests, so a kami that stopped on one node and
// started on another kept being served on the OLD node until the clock caught
// up with the stamp — even after its own sub-objects had refreshed.
describe('A1: the harvest cache serves the node a kami is on now', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a kami that moved nodes is served on its new node after a backward clock step', () => {
    // stamps from earlier cases in this worker were taken on the REAL
    // monotonic clock; start the fake one past them (a fake clock that began
    // behind a real stamp would be a backward step of its own)
    const realPerf = performance.now();
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.advanceTimersByTime(realPerf + 1_000);
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    const m = makeMirror();
    const t = nowSec();
    const e = addKami(m, { index: 901, state: 'HARVESTING', node: 7, lastTime: t - 600 });
    anchor(t);
    expect(buildKamiVitals(m, e).node?.index).toBe(7);

    // the kami stops and starts again on node 9: same harvest entity, new node
    addNode(m, 9);
    const kamiId = hashArgs(['kami.id', 901], ['string', 'uint32']);
    const harvest = m.world.entityToIndex.get(hashArgs(['harvest', kamiId], ['string', 'uint256']))!;
    setComponent(m.components.SourceID, harvest, {
      value: hashArgs(['node', 9], ['string', 'uint32']),
    });

    // a re-anchor steps the projection clock back 120 s; 120.5 s pass
    anchor(t - 120);
    vi.advanceTimersByTime(120_500);
    expect(buildKamiVitals(m, e).node?.index).toBe(9);
  });
});
