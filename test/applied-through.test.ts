// A5 — exact freshness on every answer: the appliedThrough mark, the
// `--at-least` wait, and its arguments.

import { Subject } from 'rxjs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StreamResponse } from 'clients/kamigaze';
import { createDecode } from 'engine/encoders';
import { Components, createWorld, getComponentValue } from 'engine/recs';
import { formatComponentID, formatEntityID } from 'engine/utils';
import { createComponents } from 'network/components';
import { applyNetworkUpdates } from 'network/setup';
import { KamiLensDaemon } from '../src/daemon';
import {
  MAX_WAIT_CAP_MS,
  MAX_WAIT_DEFAULT_MS,
  routeCliArgs,
  takeFreshnessArgs,
} from '../src/queries/registry';
import { onAppliedAdvance, resetSyncHealth, syncHealth, syncHooks } from '../src/sync-health';
import { Ack } from 'workers/sync';
import { createStream, markerEvent, type StreamClient } from 'workers/sync/stream';
import { NetworkComponentUpdate, NetworkEvent, NetworkEvents } from 'workers/types';
import { COMPONENT_ID, WORLD, encodeValue, poolProvider, reader } from './support/chain';

const COMPONENT = formatComponentID(COMPONENT_ID);

function mirror() {
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
  return { world, components, ecsEvents$ };
}

const write = (entity: string, value: number[], blockNumber: number, logIndex: number) =>
  ({
    type: NetworkEvents.NetworkComponentUpdate,
    component: COMPONENT,
    entity: formatEntityID(entity),
    value: { value },
    blockNumber,
    logIndex,
    lastEventInTx: true,
    txHash: `0xtx${blockNumber}-${logIndex}`,
  }) as unknown as NetworkComponentUpdate;

beforeEach(() => resetSyncHealth());

describe('A5: appliedThrough moves on the APPLY side, and only as far as a mark vouches', () => {
  it('the bootstrap mark, a frame mark, and an unanchored mark', () => {
    const { ecsEvents$, world } = mirror();
    expect(syncHealth.appliedThrough).toBeNull();
    ecsEvents$.next([markerEvent({ anchor: null, through: 1_000 }) as NetworkEvent]);
    expect(syncHealth.appliedThrough).toBe(1_000);
    // a frame in block 1005 on a chain anchored at 998 (<= 1000): through 1004
    ecsEvents$.next([{ ...write('0xa1', [1], 1_005, 2), appliedMark: { anchor: 998, through: 1_004 } } as NetworkEvent]);
    expect(syncHealth.appliedThrough).toBe(1_004);
    // a mark anchored ABOVE what is applied says nothing yet
    ecsEvents$.next([markerEvent({ anchor: 2_000, through: 2_050 }) as NetworkEvent]);
    expect(syncHealth.appliedThrough).toBe(1_004);
    world.dispose();
  });

  it('the mark is acted on only after the writes before it are in the mirror', () => {
    const { ecsEvents$, world, components } = mirror();
    ecsEvents$.next([markerEvent({ anchor: null, through: 100 }) as NetworkEvent]);
    let seen: unknown;
    const off = onAppliedAdvance(() => {
      const e = world.entityToIndex.get(formatEntityID('0xb2'))!;
      seen = getComponentValue(components.Value, e)?.value;
    });
    ecsEvents$.next([
      write('0xb2', [42], 105, 0) as NetworkEvent,
      markerEvent({ anchor: 100, through: 105 }) as NetworkEvent,
    ]);
    off();
    expect(syncHealth.appliedThrough).toBe(105);
    expect(seen).toEqual([42]);
    world.dispose();
  });

  it('a reconcile marker moves reconciledThrough, contiguously, and never past what it proved', () => {
    const { ecsEvents$, world } = mirror();
    syncHealth.reconciledThrough = 900;
    ecsEvents$.next([markerEvent({ anchor: null, through: 1_010 }) as NetworkEvent]);
    ecsEvents$.next([markerEvent({ anchor: 950, through: 1_000, reconciled: true }) as NetworkEvent]);
    expect(syncHealth.reconciledThrough).toBe(900); // not contiguous with 900
    ecsEvents$.next([markerEvent({ anchor: 900, through: 1_000, reconciled: true }) as NetworkEvent]);
    expect(syncHealth.reconciledThrough).toBe(1_000);
    expect(syncHealth.appliedThrough).toBe(1_010); // never lowered
    world.dispose();
  });

  it('end to end: stream frames carry marks; appliedThrough = newest frame block - 1', async () => {
    const { ecsEvents$, world, components } = mirror();
    ecsEvents$.next([markerEvent({ anchor: null, through: 99 }) as NetworkEvent]);
    const ev = (entity: string, value: number[]) => ({
      eventType: 'ComponentValueSet',
      componentId: COMPONENT_ID,
      entityId: entity,
      txHash: '0x01',
      value: Buffer.from(encodeValue(value).slice(2), 'hex'),
    });
    const f = (b: number, li: number, pb: number, pli: number, events: unknown[]) =>
      ({ blockNumber: b, logIndex: li, prevBlockNumber: pb, prevLogBlockNumber: pb, prevLogIndex: pli, blockTimestamp: 0, ecsEvents: events, transactionsConfirmed: [] }) as unknown as StreamResponse;
    const client: StreamClient = {
      subscribeToStream: (() =>
        (async function* () {
          for (const fr of [
            f(100, 3, 99, 0, [ev('0xc1', [1])]),
            f(100, 7, 100, 3, [ev('0xc1', [2])]),
            f(103, 0, 100, 7, [ev('0xc2', [9])]),
          ]) {
            await new Promise((r) => setTimeout(r, 2));
            yield fr;
          }
          await new Promise(() => {});
        })()) as StreamClient['subscribeToStream'],
      getEventsSince: (async () => ({ events: [], latestBlock: 0 })) as never,
    };
    const sub = createStream({
      url: 'http://fake',
      worldAddress: WORLD,
      decode: createDecode(),
      includeSystemCalls: false,
      fetchWorldEvents: reader(poolProvider([], { single: () => 5_000, batch: () => 5_000 })),
      rpcHead: { cached: () => 5_000, fetch: async () => 5_000 },
      createClient: () => client,
      timeoutMs: 30_000,
      reconcileIntervalMs: 0,
    }).subscribe((e) => ecsEvents$.next([e as NetworkEvent]));
    await new Promise((r) => setTimeout(r, 60));
    sub.unsubscribe();
    // block 100 is complete only once a frame from a LATER block arrived
    expect(syncHealth.appliedThrough).toBe(102);
    const c1 = world.entityToIndex.get(formatEntityID('0xc1'))!;
    expect(getComponentValue(components.Value, c1)?.value).toEqual([2]);
    world.dispose();
  });
});

describe('A5: --at-least waits for the mark, or refuses NOT_APPLIED', () => {
  const daemon = () => new KamiLensDaemon({ dataDir: path.join(os.tmpdir(), 'kami-lens-atleast-void') });

  it('resolves as soon as appliedThrough reaches the block', async () => {
    const d = daemon();
    syncHealth.appliedThrough = 100;
    const t0 = Date.now();
    const p = d.waitApplied(105, 2_000);
    setTimeout(() => {
      // the apply path's own way of moving the mark
      const { ecsEvents$, world } = mirror();
      ecsEvents$.next([markerEvent({ anchor: 100, through: 105 }) as NetworkEvent]);
      world.dispose();
    }, 50);
    await expect(p).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('an already-applied block answers at once', async () => {
    syncHealth.appliedThrough = 500;
    await expect(daemon().waitApplied(500, 10)).resolves.toBeUndefined();
  });

  it('times out with NOT_APPLIED carrying the current appliedThrough', async () => {
    syncHealth.appliedThrough = 100;
    await expect(daemon().waitApplied(200, 80)).rejects.toMatchObject({
      code: 'NOT_APPLIED',
      appliedThrough: 100,
      message: expect.stringContaining('appliedThrough=100'),
    });
  });

  it('asks the stream for ONE catch-up read when the chain is past the block', async () => {
    const d = daemon();
    syncHealth.appliedThrough = 100;
    d.headSample = { blockNumber: 300, sampledAt: new Date().toISOString(), sampledAtWallMs: Date.now() };
    const asked = vi.fn();
    syncHooks.requestCatchUp = asked;
    await expect(d.waitApplied(200, 1_300)).rejects.toMatchObject({ code: 'NOT_APPLIED' });
    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked).toHaveBeenCalledWith(200);
    syncHooks.requestCatchUp = undefined;
  }, 5_000);
});

describe('A5: --at-least / --max-wait arguments', () => {
  it('are taken off the tokens, with the documented default and cap', () => {
    expect(takeFreshnessArgs('kami', ['42', '--at-least', '1000'])).toEqual({
      args: ['42'],
      freshness: { atLeast: 1000, maxWaitMs: MAX_WAIT_DEFAULT_MS },
    });
    expect(takeFreshnessArgs('node', ['9', '--with-vitals', '--at-least=7', '--max-wait=2500'])).toEqual({
      args: ['9', '--with-vitals'],
      freshness: { atLeast: 7, maxWaitMs: 2500 },
    });
    expect(MAX_WAIT_DEFAULT_MS).toBe(5_000);
    expect(MAX_WAIT_CAP_MS).toBe(30_000);
  });

  it.each([
    [['--at-least'], 'needs a non-negative integer'],
    [['--at-least', '-1'], 'needs a non-negative integer'],
    [['--at-least', '1.5'], 'needs a non-negative integer'],
    [['--at-least', '9', '--max-wait', '30001'], 'capped at 30000'],
    [['--max-wait', '100'], 'needs --at-least'],
  ])('%j is BAD_ARGS', (tokens, msg) => {
    expect(() => takeFreshnessArgs('kami', tokens)).toThrow(expect.objectContaining({ code: 'BAD_ARGS', message: expect.stringContaining(msg) }));
  });

  it('is refused on status, which is not a world read', () => {
    expect(() => takeFreshnessArgs('status', ['--at-least', '1'])).toThrow(/not to 'status'/);
  });

  it('the CLI validates it with the same function and passes it through to the daemon', () => {
    const { positional } = routeCliArgs('kami', ['42', '--at-least', '1000']);
    expect(positional).toEqual(['--at-least', '1000', '--max-wait', '5000', '42']);
    expect(() => routeCliArgs('kami', ['42', '--max-wait', '5'])).toThrow(/needs --at-least/);
  });
});
