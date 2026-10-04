// A1 — the post-stall clock rule (src/daemon.ts syncClock).
//
// The projection clock is re-anchored every 300 s on the header time of the
// newest block the stream delivered. Across a stream stall that block is
// frozen, so each tick re-observed the SAME old header against a later wall
// time: now() was pinned to the frozen block's timestamp and every projection
// computed on a past instant, by up to the length of the stall. A sample is
// now taken only on a block newer than the previous sample's.

import os from 'node:os';
import path from 'node:path';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as clock from 'clock';
import { SyncState } from 'engine/constants';
import { log } from 'utils/logger';
import { NetworkEvents } from 'workers/types';
import { KamiLensDaemon } from '../src/daemon';

// The 1.0.2 cases below drive the daemon's REAL status tap (bootstrap's
// subscription to the sync worker's events). The worker is replaced by a
// Subject the test feeds, and the recs apply is stubbed out — these cases are
// about which block the clock samples and when, not about applying writes.
// The two A1 cases above never bootstrap, so neither stub reaches them.
const fake = vi.hoisted(() => ({
  worker: null as null | { ecsEvents$: Subject<unknown[]>; input$: Subject<unknown>; dispose: () => void },
}));
vi.mock('workers/create', () => ({
  createSyncWorker: () => {
    fake.worker = { ecsEvents$: new Subject<unknown[]>(), input$: new Subject<unknown>(), dispose: () => {} };
    return fake.worker;
  },
}));
vi.mock('network/setup', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  applyNetworkUpdates: () => {},
}));

type Internals = {
  liveBlockNumber: number;
  clockProvider: { getBlock: (n: number) => Promise<{ timestamp: number } | null> };
  syncClock: () => Promise<void>;
};

afterEach(() => clock.reset());

describe('A1: the clock is never re-anchored on a frozen block', () => {
  it('a stalled stream keeps wall time + the last offset instead of pinning now() to the frozen block', async () => {
    const d = new KamiLensDaemon({ dataDir: path.join(os.tmpdir(), 'kami-lens-clock-void') });
    const internals = d as unknown as Internals;
    const headerTime = Math.floor(Date.now() / 1000) - 10; // a block 10 s old
    const asked: number[] = [];
    internals.clockProvider = {
      getBlock: async (n) => {
        asked.push(n);
        return { timestamp: headerTime };
      },
    };

    internals.liveBlockNumber = 1_000;
    await internals.syncClock();
    expect(clock.lastObservation()?.blockNumber).toBe(1_000);
    const offsetAfterFirst = clock.offset();

    // the stream stalls; 300 s later the tick comes round on the SAME block.
    // Re-observing it would set offset = header - (wall now), i.e. walk the
    // clock back by every second of the stall.
    await internals.syncClock();
    expect(asked).toEqual([1_000]); // not even asked
    expect(clock.offset()).toBe(offsetAfterFirst);

    // the stream recovers: a newer block is sampled
    internals.liveBlockNumber = 1_005;
    await internals.syncClock();
    expect(asked).toEqual([1_000, 1_005]);
    expect(clock.lastObservation()?.blockNumber).toBe(1_005);
  });
});

describe('A1: the clock is not anchored on the boot block at LIVE', () => {
  it('the boot block counts as sampled; the first newer block is the first sample', async () => {
    const d = new KamiLensDaemon({ dataDir: path.join(os.tmpdir(), 'kami-lens-clock-void') });
    const internals = d as unknown as Internals & { startClockSync: () => void; clockSyncTimer: NodeJS.Timeout | null };
    const asked: number[] = [];
    internals.clockProvider = {
      getBlock: async (n) => {
        asked.push(n);
        return { timestamp: Math.floor(Date.now() / 1000) };
      },
    };
    // at LIVE the newest block is the cache's / the fill's — minutes old
    internals.liveBlockNumber = 34_006_517;
    internals.startClockSync();
    await internals.syncClock();
    expect(asked).toEqual([]); // the boot block is never sampled
    internals.liveBlockNumber = 34_006_700; // the stream delivers a fresh block
    await internals.syncClock();
    expect(asked).toEqual([34_006_700]);
    if (internals.clockSyncTimer) clearInterval(internals.clockSyncTimer);
  });
});

// 1.0.2 — the projection clock samples a FRESH block.
//
// Until 1.0.2 the 300 s timer read the header of the newest block the stream
// had delivered, however long ago that was, and set offset = header time −
// wall now. The offset therefore carried that block's AGE at the moment of the
// read, and every projection ran that far in the past for the next 300 s. A
// live session on 2026-10-04 measured clockOffsetMs between −2,979 and
// −23,977; the −23,977 was a sample taken inside a 26 s gap between blocks.
// The timer now only ARMS the sample (the post-LIVE flag); the sample is
// taken on the next stream event of a block newer than the last sample.
//
// Model: one chain block per second, block B(t) produced at wall second
// T0 + t with header time T0 + t, delivered by the stream at that same
// instant, header reads answering at once. Chain time and wall time agree,
// so the TRUE offset is 0 and any non-zero offset is the sampled block's age.

const T0 = 1_759_000_000; // wall/chain seconds at t = 0
const B = (t: number) => 40_000_000 + t; // the block produced at t

type TapInternals = {
  liveBlockNumber: number;
  liveAt: string | null;
  stopped: boolean;
  clockProvider: {
    getBlock: (n: number | string) => Promise<{ number?: number; timestamp: number } | null>;
  };
  clockSyncTimer: NodeJS.Timeout | null;
  bootstrap: () => void;
  startClockSync: () => void;
  teardownWorker: () => void;
  // 1.0.3: the LIVE transition itself, and the onLive side effects a
  // hermetic test must not run (a store read, the checkpoint child, Kamiden)
  onSyncStatus: (s: { state: SyncState; msg: string; percentage: number }) => void;
  readCheckpointReport: (ms: number) => Promise<unknown>;
  checkpoint: () => Promise<void>;
  kamiden: { start: () => void };
};

type HeaderAnswer = 'ok' | 'null' | 'throw' | 'hang';

/** A LIVE daemon whose clock timer started at `tLive` (so it ticks at
 * tLive + 300 s), with its boot block ten minutes old. `header(n)` decides how
 * the header read of block n answers ('hang': never — 1.0.3).
 *
 * By default the harness sets the daemon LIVE the way 1.0.2's tests always
 * did — liveAt, the boot block, startClockSync — which is the post-seed half
 * of LIVE, i.e. a LIVE whose 1.0.3 seed did not land. `viaLive` instead
 * sends the worker's LIVE status through onSyncStatus, the real transition
 * (1.0.3), with the chain head's header answering as `head` says, the head
 * block `headAgeSec` old. */
function liveDaemon(
  tLive: number,
  header: (n: number) => HeaderAnswer = () => 'ok',
  opts: { viaLive?: boolean; head?: () => HeaderAnswer; headAgeSec?: number } = {}
) {
  vi.useFakeTimers({
    now: (T0 + tLive) * 1000,
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  const d = new KamiLensDaemon({ dataDir: path.join(os.tmpdir(), 'kami-lens-clock-void') });
  const internals = d as unknown as TapInternals;
  const asked: (number | string)[] = [];
  const answer = async <T>(how: HeaderAnswer, value: () => T): Promise<T | null> => {
    if (how === 'throw') throw new Error('header read failed');
    if (how === 'null') return null; // a lagging load-balanced backend
    if (how === 'hang') return new Promise<never>(() => {}); // a read that never returns
    return value();
  };
  internals.clockProvider = {
    getBlock: async (n) => {
      asked.push(n);
      if (n === 'latest') {
        const headT = Math.floor(Date.now() / 1000) - T0 - (opts.headAgeSec ?? 0);
        return answer((opts.head ?? (() => 'ok'))(), () => ({
          number: B(headT),
          timestamp: T0 + headT,
        }));
      }
      return answer(header(n as number), () => ({ timestamp: T0 + ((n as number) - B(0)) }));
    },
  };
  internals.bootstrap();
  internals.liveBlockNumber = B(tLive - 600); // the boot block
  /** the observation as it stood when LIVE was REPORTED (status$), and when */
  const atLive: { observation?: ReturnType<typeof clock.lastObservation>; at?: number } = {};
  if (opts.viaLive) {
    internals.readCheckpointReport = async () => ({});
    internals.checkpoint = async () => {};
    internals.kamiden.start = () => {};
    d.status$.subscribe((st) => {
      if (st.state === 'LIVE' && atLive.at === undefined) {
        atLive.observation = clock.lastObservation();
        atLive.at = Date.now();
      }
    });
    internals.onSyncStatus({ state: SyncState.LIVE, msg: 'Streaming Live Events', percentage: 100 });
  } else {
    internals.liveAt = new Date().toISOString();
    internals.startClockSync();
  }

  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  /** advance wall time to t (firing the clock timer on the way) */
  const to = async (t: number) => {
    const delta = (T0 + t) * 1000 - Date.now();
    if (delta > 0) await vi.advanceTimersByTimeAsync(delta);
    await flush();
  };
  /** one write of block B(t), as the worker hands it to the daemon */
  const write = (t: number, extra: Record<string, unknown> = {}) => ({
    type: NetworkEvents.NetworkComponentUpdate,
    component: '0x01',
    entity: '0x01',
    value: undefined,
    lastEventInTx: true,
    txHash: `0x${B(t).toString(16)}`,
    blockNumber: B(t),
    logIndex: 1,
    ...extra,
  });
  /** the stream delivers block B(t) at t */
  const deliver = async (t: number) => {
    await to(t);
    fake.worker!.ecsEvents$.next([write(t)]);
    await flush();
  };
  /** at wall time `at`, ONE worker batch carrying writes of B(t) for each t
   * in `ts`, in that order — a gap heal's range ahead of the frame that
   * triggered it, or a reconcile pass's re-read writes (`final: true`, as a
   * proven chain read marks them) */
  const batch = async (at: number, ts: number[], extra: Record<string, unknown> = {}) => {
    await to(at);
    fake.worker!.ecsEvents$.next(ts.map((t) => write(t, extra)));
    await flush();
  };
  const close = () => {
    internals.stopped = true;
    if (internals.clockSyncTimer) clearInterval(internals.clockSyncTimer);
    internals.teardownWorker();
  };
  return { asked, to, deliver, batch, close, atLive, daemon: d };
}

describe('1.0.2: the clock timer arms a sample; the next newer block takes it', () => {
  let close: (() => void) | null = null;
  afterEach(() => {
    close?.();
    close = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a tick while the newest streamed block is OLD takes no sample; the next newer block is sampled at once', async () => {
    const h = liveDaemon(-300); // ticks at t = 0
    close = h.close;
    for (let t = -298; t <= -20; t += 2) await h.deliver(t);
    // the post-LIVE sample, and its one follow-up 30 s later (B2)
    expect(h.asked).toEqual([B(-298), B(-268)]);
    expect(clock.offset()).toBe(0);

    // the tick lands 20 s after the newest block: reading B(-20) now would set
    // the offset to −20 s. It must read nothing and leave the offset alone.
    await h.to(0);
    expect(h.asked).toEqual([B(-298), B(-268)]);
    expect(clock.offset()).toBe(0);
    expect(clock.lastObservation()?.blockNumber).toBe(B(-268));

    // the next block is sampled on its own event, so its age is ~0
    await h.deliver(15);
    expect(h.asked).toEqual([B(-298), B(-268), B(15)]);
    expect(clock.lastObservation()).toEqual({
      blockTimestampSec: T0 + 15,
      blockNumber: B(15),
      atWallMs: (T0 + 15) * 1000,
    });
    expect(clock.offset()).toBe(0);

    // one sample per arming: the block after it is not sampled
    await h.deliver(17);
    expect(h.asked).toEqual([B(-298), B(-268), B(15)]);
  });

  it('the scripted gap: blocks at 0, 2, 4, 30, 32 s and a tick at 28 s — the sample is the 30 s block read at 30 s', async () => {
    const h = liveDaemon(-272); // ticks at t = 28
    close = h.close;
    for (let t = -270; t <= 4; t += 2) await h.deliver(t); // ..., 0, 2, 4
    expect(clock.lastObservation()?.blockNumber).toBe(B(-240)); // the B2 follow-up
    await h.to(28); // the tick, 24 s into a 26 s gap
    await h.deliver(30);
    await h.deliver(32);
    // NOT the 4 s block read at 28 s (offset −24,000)
    expect(clock.offset()).toBe(0);
    expect(clock.lastObservation()).toEqual({
      blockTimestampSec: T0 + 30,
      blockNumber: B(30),
      atWallMs: (T0 + 30) * 1000,
    });
    expect(h.asked).toEqual([B(-270), B(-240), B(30)]);
  });

  it('a null header leaves the sample armed; the following newer block is sampled', async () => {
    const h = liveDaemon(-300, (n) => (n === B(5) ? 'null' : 'ok'));
    close = h.close;
    for (let t = -298; t <= -2; t += 2) await h.deliver(t);
    await h.to(0); // the tick arms
    await h.deliver(5); // its header is not served yet
    expect(h.asked).toEqual([B(-298), B(-268), B(5)]); // B(-268): the B2 follow-up
    expect(clock.lastObservation()?.blockNumber).toBe(B(-268));
    await h.deliver(7); // tried at once, not 300 s later
    expect(h.asked).toEqual([B(-298), B(-268), B(5), B(7)]);
    expect(clock.lastObservation()?.blockNumber).toBe(B(7));
    expect(clock.offset()).toBe(0);
  });

  it.each(['null', 'throw'] as const)(
    'the first sample after LIVE re-arms on a %s header read; the next newer block is tried',
    async (how) => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const h = liveDaemon(0, (n) => (n === B(2) ? how : 'ok'));
      close = h.close;
      await h.deliver(2);
      expect(h.asked).toEqual([B(2)]);
      expect(clock.lastObservation()).toBeNull();
      if (how === 'throw') expect(warn).toHaveBeenCalledWith('[daemon] clock sync failed', expect.any(Error));
      await h.deliver(4);
      expect(h.asked).toEqual([B(2), B(4)]);
      expect(clock.lastObservation()?.blockNumber).toBe(B(4));
      expect(clock.offset()).toBe(0);
    }
  );
});

// 1.0.2 — WHICH EVENT takes an armed sample, and WHICH BLOCK it reads.
//
// Not every event the daemon receives is the stream delivering something new.
// The periodic reconcile re-emits every write it re-read, each on its own
// (older) block; a gap heal emits the healed range, oldest block first, ahead
// of the frame that triggered it; an --at-least catch-up emits a proven range.
// An event of a block at or below the newest one delivered says nothing about
// "now", so it never takes the sample: only an event that delivers a block
// NEWER than any delivered so far does. And the header read is of the newest
// block of that worker batch — the whole burst, not its first block — because
// the read happens once the batch has been taken in.

describe('1.0.2: only a newer-than-delivered block takes the sample; the read is of the newest block of the batch', () => {
  let close: (() => void) | null = null;
  afterEach(() => {
    close?.();
    close = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('after a tick, a reconcile write of an older block takes no sample and leaves it armed', async () => {
    const h = liveDaemon(-300); // ticks at t = 0
    close = h.close;
    for (let t = -298; t <= -20; t += 2) await h.deliver(t);
    await h.to(0); // armed; the newest delivered block is B(-20)
    // newer than the last SAMPLE (B(-298)), not newer than B(-20)
    await h.batch(5, [-100], { final: true });
    expect(h.asked).toEqual([B(-298), B(-268)]); // B(-268): the B2 follow-up
    expect(clock.lastObservation()?.blockNumber).toBe(B(-268));
    await h.deliver(9); // still armed: the next newer block takes it
    expect(h.asked).toEqual([B(-298), B(-268), B(9)]);
    expect(clock.offset()).toBe(0);
  });

  it('after a tick, one batch delivering N, N+1, N+2 takes ONE sample, on N+2', async () => {
    const h = liveDaemon(-300);
    close = h.close;
    for (let t = -298; t <= -20; t += 2) await h.deliver(t);
    await h.to(0);
    await h.batch(10, [8, 9, 10]); // every one of them is newer than B(-20)
    expect(h.asked).toEqual([B(-298), B(-268), B(10)]); // B(-268): the B2 follow-up
    expect(clock.lastObservation()).toEqual({
      blockTimestampSec: T0 + 10,
      blockNumber: B(10),
      atWallMs: (T0 + 10) * 1000,
    });
    expect(clock.offset()).toBe(0);
  });

  it('after LIVE, a reconcile write of an older block takes no sample and leaves it armed', async () => {
    // the first newer block's header is not served yet, so the sample stays
    // armed with B(2) delivered and the boot block as the last sample
    const h = liveDaemon(0, (n) => (n === B(2) ? 'null' : 'ok'));
    close = h.close;
    await h.deliver(2);
    expect(h.asked).toEqual([B(2)]);
    await h.batch(3, [1], { final: true }); // newer than the boot block, not than B(2)
    expect(h.asked).toEqual([B(2)]);
    await h.deliver(4);
    expect(h.asked).toEqual([B(2), B(4)]);
    expect(clock.lastObservation()?.blockNumber).toBe(B(4));
    expect(clock.offset()).toBe(0);
  });

  it('after LIVE, one batch delivering N, N+1, N+2 takes ONE sample, on N+2', async () => {
    const h = liveDaemon(0);
    close = h.close;
    await h.batch(10, [8, 9, 10]);
    expect(h.asked).toEqual([B(10)]);
    expect(clock.lastObservation()?.blockNumber).toBe(B(10));
    expect(clock.offset()).toBe(0);
  });

  it('after a stall, a gap heal that starts AT the frozen block samples the newest block of the batch', async () => {
    const h = liveDaemon(-150); // ticks at t = 150, outside this case
    close = h.close;
    for (let t = -148; t <= -100; t += 2) await h.deliver(t);
    expect(h.asked).toEqual([B(-148), B(-118)]); // B(-118): the B2 follow-up
    // 100 s of silence; the first frame after it heals from the last block
    // delivered (B(-100)) through its own block, oldest first
    await h.batch(0, [-100, -60, 0]);
    expect(h.asked).toEqual([B(-148), B(-118), B(0)]); // NOT B(-100), 100 s old
    expect(clock.offset()).toBe(0);
  });

  it('after a stall, a reconcile write of an older block takes no sample; the next newer block does', async () => {
    const h = liveDaemon(-150);
    close = h.close;
    for (let t = -148; t <= -100; t += 2) await h.deliver(t);
    await h.batch(0, [-120], { final: true }); // a reconcile pass lands inside the stall
    expect(h.asked).toEqual([B(-148), B(-118)]); // B(-118): the B2 follow-up
    // the stream resumes 20 s later — no longer a "stall" by the 60 s rule,
    // yet the re-anchor the stall asked for is still owed
    await h.deliver(20);
    expect(h.asked).toEqual([B(-148), B(-118), B(20)]);
    expect(clock.offset()).toBe(0);
  });
});

// 1.0.2 (B2) — one follow-up sample about 30 s after the first one.
//
// The first sample after LIVE, or after a stall, is taken on the first block
// the stream delivers then — and that block can itself be old: the stream
// replays its backlog first (−7.0 s measured on the clock-only candidate). It
// then stood for 300 s. So that sample arms ONE more, CLOCK_FOLLOW_UP_MS
// (30 s) after it, taken by the same rule as every other; then the 300 s
// cadence alone.

describe('1.0.2 (B2): a follow-up sample ~30 s after the first one after LIVE or a stall', () => {
  let close: (() => void) | null = null;
  afterEach(() => {
    close?.();
    close = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('after LIVE: the first sample is on an old backlog block; 30 s later one more, then only the 300 s cadence', async () => {
    const h = liveDaemon(0); // ticks at t = 300
    close = h.close;
    await h.batch(2, [-5]); // the stream's first delivery: a block from 7 s ago
    expect(h.asked).toEqual([B(-5)]);
    expect(clock.offset()).toBe(-7_000);
    for (let t = 4; t <= 30; t += 2) await h.deliver(t);
    expect(h.asked).toEqual([B(-5)]); // not yet
    await h.deliver(32); // the follow-up, armed at t = 32 (the first sample + 30 s)
    expect(h.asked).toEqual([B(-5), B(32)]);
    expect(clock.offset()).toBe(0);
    for (let t = 34; t <= 298; t += 2) await h.deliver(t);
    expect(h.asked).toEqual([B(-5), B(32)]); // ONE follow-up, not a second cadence
    await h.to(300); // the tick
    await h.deliver(302);
    for (let t = 304; t <= 360; t += 2) await h.deliver(t);
    expect(h.asked).toEqual([B(-5), B(32), B(302)]); // a tick's sample has no follow-up
  });

  it('after a stall: the first sample is on an old block; 30 s later one more', async () => {
    const h = liveDaemon(-150); // ticks at t = 150
    close = h.close;
    for (let t = -148; t <= -100; t += 2) await h.deliver(t);
    expect(h.asked).toEqual([B(-148), B(-118)]); // the post-LIVE sample and its follow-up
    // 100 s of silence; the reconnect's first delivery is a backlog block from 8 s ago
    await h.batch(0, [-8]);
    expect(h.asked).toEqual([B(-148), B(-118), B(-8)]);
    expect(clock.offset()).toBe(-8_000);
    for (let t = 2; t <= 28; t += 2) await h.deliver(t);
    expect(h.asked).toEqual([B(-148), B(-118), B(-8)]);
    await h.deliver(30); // armed at t = 30
    expect(h.asked).toEqual([B(-148), B(-118), B(-8), B(30)]);
    expect(clock.offset()).toBe(0);
    for (let t = 32; t <= 140; t += 2) await h.deliver(t);
    expect(h.asked).toEqual([B(-148), B(-118), B(-8), B(30)]);
  });
});

// 1.0.3 — the clock has a value from LIVE on, and a hung header read cannot
// delay it.
//
// Found on a 1.0.2 deploy (2026-10-04): the first header read after LIVE hung
// on the public RPC until the provider's own timeout, so for 47 s there was
// no sample at all and clock.now() was the raw wall clock — up to ~3 s AHEAD
// of the chain, whose block timestamps run 0.3-3 s behind the wall clock when
// a block appears. C1: every clock header read gives up after
// CLOCK_READ_TIMEOUT_MS (5 s) and re-arms. C2: when the worker reports LIVE
// and no sample exists, the clock is seeded from the chain head's header
// BEFORE the daemon reports LIVE (within one shared 5 s budget); the seed is
// behind by the head's age, and the first freshly delivered block replaces it.

describe('1.0.3 (C1): a hung clock header read gives up after 5 s and re-arms', () => {
  let close: (() => void) | null = null;
  afterEach(() => {
    close?.();
    close = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a read that never resolves: within 5 s the sample is re-armed, and the next newer block takes it', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const h = liveDaemon(0, (n) => (n === B(2) ? 'hang' : 'ok'));
    close = h.close;
    await h.deliver(2); // the read of B(2) hangs
    expect(h.asked).toEqual([B(2)]);
    await h.deliver(6); // 4 s in: still in flight, nothing armed
    expect(h.asked).toEqual([B(2)]);
    await h.to(7); // 5 s: the read gives up
    expect(warn).toHaveBeenCalledWith('[daemon] clock sync failed', expect.any(Error));
    await h.deliver(8);
    expect(h.asked).toEqual([B(2), B(8)]);
    expect(clock.lastObservation()?.blockNumber).toBe(B(8));
    expect(clock.offset()).toBe(0);
  });
});

describe('1.0.3 (C2): the clock is seeded from the chain head when the daemon goes LIVE', () => {
  let close: (() => void) | null = null;
  afterEach(() => {
    close?.();
    close = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('LIVE is reported with a sample on the HEAD (not the boot block); the first fresh block replaces it; one +30 s follow-up', async () => {
    const h = liveDaemon(0, () => 'ok', { viaLive: true, headAgeSec: 1 });
    close = h.close;
    await h.to(0);
    expect(h.daemon.getStatus().state).toBe('LIVE');
    // set when LIVE was reported: the head, one second old — behind, never ahead
    expect(h.atLive.observation).toEqual({
      blockTimestampSec: T0 - 1,
      blockNumber: B(-1),
      atWallMs: T0 * 1000,
    });
    expect(h.atLive.observation?.blockNumber).not.toBe(B(-600)); // the boot block
    expect(clock.offset()).toBe(-1_000);
    expect(h.asked).toEqual(['latest']);
    // a backlog block older than the seed's head does not replace it
    await h.batch(1, [-3]);
    expect(h.asked).toEqual(['latest']);
    // the first freshly delivered block does
    await h.deliver(2);
    expect(h.asked).toEqual(['latest', B(2)]);
    expect(clock.lastObservation()?.blockNumber).toBe(B(2));
    expect(clock.offset()).toBe(0);
    // ...and arms the one follow-up, 30 s after it — once
    for (let t = 4; t <= 298; t += 2) await h.deliver(t);
    expect(h.asked).toEqual(['latest', B(2), B(32)]);
  });

  it.each(['throw', 'null', 'hang'] as const)(
    'a head read that fails every attempt (%s): LIVE within the 5 s budget, offset 0, a WARN line, then 1.0.2',
    async (how) => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const h = liveDaemon(0, () => 'ok', { viaLive: true, head: () => how });
      close = h.close;
      if (how === 'hang') {
        await h.to(4.9);
        expect(h.daemon.getStatus().state).not.toBe('LIVE'); // still seeding
      }
      await h.to(5);
      expect(h.daemon.getStatus().state).toBe('LIVE');
      expect(h.atLive.at).toBeLessThanOrEqual((T0 + 5) * 1000);
      expect(h.atLive.observation).toBeNull();
      expect(clock.offset()).toBe(0);
      // bounded: immediate retries on a fast failure, one attempt when it hangs
      expect(h.asked).toEqual(how === 'hang' ? ['latest'] : ['latest', 'latest', 'latest']);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[daemon\] clock seed at LIVE failed/));
      // the first delivered block samples as in 1.0.2, and arms its follow-up
      await h.deliver(6);
      expect(h.asked.slice(-1)).toEqual([B(6)]);
      expect(clock.lastObservation()?.blockNumber).toBe(B(6));
      for (let t = 8; t <= 40; t += 2) await h.deliver(t);
      expect(h.asked.filter((n) => typeof n === 'number')).toEqual([B(6), B(36)]);
    }
  );
});
