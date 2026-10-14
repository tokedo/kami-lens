// 1.0.5 — a write the apply path's guard skips can be read from the log.
//
// The guard (network/setup/utils.ts) skips an update whose block is older
// than the place the mirror holds for its key, or of the same block when the
// held write is block-final, and until 1.0.5 it only counted it
// (status.sync.olderWritesSkipped). When a production daemon's reconcile
// repaired a write the stream path had left unapplied (2026-10-08), its log
// could not say whether a skip was the cause. Each skip is now one INFO line
// with the key, the write's block / logIndex / transaction index / final
// flag / tx hash, its source, the place the key held and whether the value
// equals the mirror's — at most 20 per 60 s window, the rest counted per
// source in ONE summary line at the end of the first batch after the window
// closes. The counter increments exactly as before.

import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDecode } from 'engine/encoders';
import { Components, createWorld, getComponentValue } from 'engine/recs';
import { formatComponentID, formatEntityID } from 'engine/utils';
import { createComponents } from 'network/components';
import { applyNetworkUpdates } from 'network/setup';
import { skipSourceOf } from 'network/setup/utils';
import {
  resetSyncHealth,
  SKIP_LOG_CAP,
  SKIP_LOG_WINDOW_MS,
  syncHealth,
} from '../src/sync-health';
import { log } from 'utils/logger';
import { Ack } from 'workers/sync';
import { createStream } from 'workers/sync/stream';
import { healRange } from 'workers/sync/stream/heal';
import { NetworkEvent } from 'workers/types';
import {
  COMPONENT_ID,
  emptyFrame,
  framesFor,
  poolProvider,
  reader,
  scriptedClient,
  txHashOf,
  WORLD,
  type ChainLog,
} from './support/chain';

const COMPONENT = formatComponentID(COMPONENT_ID);
const E1 = 0xe1n;
const ID1 = formatEntityID(`0x${E1.toString(16)}`);

let info: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetSyncHealth();
  info = vi.spyOn(log, 'info').mockImplementation(() => {});
});
afterEach(() => {
  info.mockRestore();
  vi.useRealTimers();
  resetSyncHealth();
});
const lines = (re: RegExp) =>
  info.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => re.test(l));
const skipLines = () => lines(/older write skipped:/);
const summaryLines = () => lines(/more older writes skipped, not logged/);

async function until(cond: () => boolean, ms = 2_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The real apply path over a fresh world, fed whole batches by hand. */
function applyPath() {
  const world = createWorld();
  const components = createComponents(world);
  const ecsEvents$ = new Subject<NetworkEvent[]>();
  applyNetworkUpdates(
    world,
    components,
    ecsEvents$ as never,
    { [COMPONENT]: 'Value' } as Record<string, keyof Components> as never,
    new Subject<Ack>()
  );
  const value = (e: bigint) => {
    const idx = world.entityToIndex.get(formatEntityID(`0x${e.toString(16)}`));
    return idx === undefined ? undefined : getComponentValue(components.Value, idx)?.value;
  };
  return { world, ecsEvents$, value, batch: (es: unknown[]) => ecsEvents$.next(es as NetworkEvent[]) };
}

/** A stream-shaped update (a log index, no transaction index, not final). */
const streamWrite = (block: number, value: number[], extra: Record<string, unknown> = {}) => ({
  type: 'NetworkComponentUpdate',
  component: COMPONENT,
  entity: ID1,
  value: { value },
  blockNumber: block,
  logIndex: 1,
  lastEventInTx: true,
  txHash: `0x${block.toString(16)}`,
  ...extra,
});

describe('1.0.5: one INFO line per skipped write', () => {
  it('a scripted stream delivers a newer write, then an older one for the same key: exactly one line, with every field', async () => {
    const newer: ChainLog = { block: 610, tx: 2, logIndex: 3, entity: E1, value: [6] };
    const older: ChainLog = { block: 605, tx: 1, logIndex: 1, entity: E1, value: [5] };
    // the frames chain, so the stream's continuity check passes them both
    const frames = [
      ...framesFor([newer, older], { block: 609, logIndex: 0 }),
      emptyFrame({ block: 611, logIndex: 0 }, { block: older.block, logIndex: older.logIndex }),
    ];
    const p = applyPath();
    let empties = 0;
    const sub = createStream({
      url: 'http://fake',
      worldAddress: WORLD,
      decode: createDecode(),
      includeSystemCalls: false,
      fetchWorldEvents: reader(poolProvider([], { single: () => 700, batch: () => 700 })),
      rpcHead: { cached: () => 700, fetch: async () => 700 },
      createClient: () => scriptedClient(frames),
      timeoutMs: 30_000,
      reconcileIntervalMs: 0,
      headWaitMs: 50,
      headPollMs: 5,
    }).subscribe((e) => {
      if ((e as { txHash?: string }).txHash === 'EmptyNetworkEvent') empties++;
      p.batch([e]);
    });
    await until(() => empties > 0); // every frame has been applied
    sub.unsubscribe();
    p.world.dispose();

    expect(p.value(E1)).toEqual([6]); // the newer write stands
    expect(syncHealth.olderWritesSkipped).toBe(1); // counted as before
    const got = skipLines();
    expect(got).toHaveLength(1);
    expect(got[0]).toBe(
      `[apply] older write skipped: Value ${ID1} block=605 logIndex=1 txIndex=- final=false ` +
        `tx=${txHashOf(older)} source=stream held=610/open value=differs (olderWritesSkipped=1)`
    );
    expect(summaryLines()).toHaveLength(0);
  });

  it('a proven chain read of an older block: final, its transaction index, the reconcile stamp named as the source', async () => {
    const chain: ChainLog[] = [
      { block: 605, tx: 4, logIndex: 2, entity: E1, value: [5] },
      { block: 610, tx: 1, logIndex: 1, entity: E1, value: [6] },
    ];
    const p = applyPath();
    p.batch([streamWrite(610, [6])]);
    // a lagging backend proves the pass only through 605 (as apply-order (h))
    const r = await healRange({
      from: 601,
      to: 610,
      reason: 'reconcile',
      fetchWorldEvents: reader(poolProvider(chain, { single: () => 606, batch: () => 606 })),
      rpcHead: { cached: () => 611, fetch: async () => 611 },
      partial: true,
      headWaitMs: 50,
      headPollMs: 5,
    });
    if (!r.ok) throw new Error('chain read deferred');
    expect(r.events.map((e) => e.blockNumber)).toEqual([605]);
    p.batch(r.events.map((e) => ({ ...e, reconcileCursor: 612 })));
    // the same read unstamped: a gap heal, a catch-up or the boot window
    p.batch(r.events);
    p.world.dispose();
    expect(p.value(E1)).toEqual([6]);
    expect(syncHealth.olderWritesSkipped).toBe(2);
    expect(skipLines()).toEqual([
      `[apply] older write skipped: Value ${ID1} block=605 logIndex=2 txIndex=4 final=true ` +
        `tx=${txHashOf(chain[0]!)} source=reconcile held=610/open value=differs (olderWritesSkipped=1)`,
      `[apply] older write skipped: Value ${ID1} block=605 logIndex=2 txIndex=4 final=true ` +
        `tx=${txHashOf(chain[0]!)} source=chain-read held=610/open value=differs (olderWritesSkipped=2)`,
    ]);
  });

  it('a late stream frame of a block whose final write is held: held=<B>/final, value=same', () => {
    const p = applyPath();
    p.batch([streamWrite(700, [7], { final: true, transactionIndex: 3 })]); // a proven read's final write
    p.batch([streamWrite(700, [7])]); // the stream's own frame of 700, after it
    p.world.dispose();
    expect(syncHealth.olderWritesSkipped).toBe(1);
    expect(skipLines()).toEqual([
      `[apply] older write skipped: Value ${ID1} block=700 logIndex=1 txIndex=- final=false ` +
        `tx=0x2bc source=stream held=700/final value=same (olderWritesSkipped=1)`,
    ]);
  });

  it('an applied write logs nothing', () => {
    const p = applyPath();
    p.batch([streamWrite(700, [1]), streamWrite(700, [2]), streamWrite(701, [3])]);
    p.world.dispose();
    expect(syncHealth.olderWritesSkipped).toBe(0);
    expect(skipLines()).toHaveLength(0);
  });

  it('the source, from the fields that reach the apply path', () => {
    expect(skipSourceOf({})).toBe('stream');
    expect(skipSourceOf({ transactionIndex: 2 })).toBe('range');
    expect(skipSourceOf({ transactionIndex: 2, final: true })).toBe('chain-read');
    expect(skipSourceOf({ transactionIndex: 2, final: true, reconcileCursor: 9 })).toBe('reconcile');
  });
});

describe('1.0.5: the cap — 20 lines per 60 s window, the rest in one summary line', () => {
  const T0 = Date.parse('2026-10-14T12:00:00.000Z');

  it('the cap and the window are 20 and 60 s', () => {
    expect(SKIP_LOG_CAP).toBe(20);
    expect(SKIP_LOG_WINDOW_MS).toBe(60_000);
  });

  it('25 skips inside one window: 20 lines, then ONE "+5 more" line at the end of the first batch after the window closes', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const p = applyPath();
    p.batch([streamWrite(900, [9])]);
    // 25 older writes of the same key: 15 stream frames and 10 reconcile
    // writes, over three batches inside the window
    p.batch(Array.from({ length: 10 }, (_, i) => streamWrite(800 + i, [i])));
    vi.setSystemTime(T0 + 30_000);
    p.batch(Array.from({ length: 5 }, (_, i) => streamWrite(810 + i, [i])));
    p.batch(
      Array.from({ length: 10 }, (_, i) =>
        streamWrite(820 + i, [i], { final: true, transactionIndex: 1, reconcileCursor: 950 })
      )
    );
    expect(syncHealth.olderWritesSkipped).toBe(25); // every skip counted
    expect(skipLines()).toHaveLength(20);
    expect(summaryLines()).toHaveLength(0); // the window is still open
    // a batch still inside the window: no summary
    vi.setSystemTime(T0 + 59_999);
    p.batch([streamWrite(901, [10])]);
    expect(summaryLines()).toHaveLength(0);
    // the first batch after the window closes (it skips nothing itself)
    vi.setSystemTime(T0 + 60_000);
    p.batch([streamWrite(902, [11])]);
    expect(summaryLines()).toEqual([
      `[apply] +5 more older writes skipped, not logged (cap 20 per 60 s; window opened ` +
        `2026-10-14T12:00:00.000Z): stream=0 range=0 reconcile=5 chain-read=0 (olderWritesSkipped=25)`,
    ]);
    // exactly one: later batches add nothing
    p.batch([streamWrite(903, [12])]);
    expect(summaryLines()).toHaveLength(1);
    // the next skip opens a new window and is logged
    p.batch([streamWrite(850, [13])]);
    expect(skipLines()).toHaveLength(21);
    expect(skipLines()[20]).toContain('block=850 ');
    expect(skipLines()[20]).toContain('(olderWritesSkipped=26)');
    p.world.dispose();
  });

  it('a window that closes mid-batch: its summary is written before the next skip s line', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const p = applyPath();
    p.batch([streamWrite(900, [9])]);
    p.batch(Array.from({ length: 21 }, (_, i) => streamWrite(800 + i, [i])));
    expect(skipLines()).toHaveLength(20);
    vi.setSystemTime(T0 + 61_000);
    p.batch([streamWrite(700, [0])]); // a skip is the first thing after the window closed
    const all = info.mock.calls.map((c: unknown[]) => String(c[0]));
    const last2 = all.slice(-2);
    expect(last2[0]).toMatch(/^\[apply\] \+1 more older writes skipped, not logged .* stream=1 range=0 reconcile=0 chain-read=0 \(olderWritesSkipped=21\)$/);
    expect(last2[1]).toMatch(/^\[apply\] older write skipped: .* block=700 .*\(olderWritesSkipped=22\)$/);
    expect(summaryLines()).toHaveLength(1);
    p.world.dispose();
  });

  it('a window the cap never reached closes with no summary line', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const p = applyPath();
    p.batch([streamWrite(900, [9])]);
    p.batch(Array.from({ length: 20 }, (_, i) => streamWrite(800 + i, [i])));
    vi.setSystemTime(T0 + 60_000);
    p.batch([streamWrite(901, [1])]);
    expect(skipLines()).toHaveLength(20);
    expect(summaryLines()).toHaveLength(0);
    expect(syncHealth.olderWritesSkipped).toBe(20);
    p.world.dispose();
  });
});
