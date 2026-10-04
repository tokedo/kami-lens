// 1.0.1 (field report 2026-10-04) — two real blocks, replayed.
//
// On Yominet a log's index restarts in every transaction, so a key's final
// value in a block is its LAST write by (transactionIndex, logIndex) — and
// nothing the stream sends says which transaction a frame belongs to. The
// two fixtures are the World logs of two real multi-transaction blocks, as
// `eth_getLogs` returned them, with entity ids, transaction hashes, block
// numbers and block hashes replaced (components, transaction indices, log
// indices and values are the chain's), replayed here as two consecutive
// blocks:
//
//   A — 44 logs in 5 transactions, indexed 1..16 then 1..7 four times (16
//       distinct indices), written to 16 keys, 7 of them by several
//       transactions; a later transaction's write mostly carries a LOWER
//       index than the earlier one's;
//   B — 27 logs in 3 transactions, indexed 1..9 in each, written to 12 keys,
//       6 of them by several transactions, every one at an EQUAL index.
//
// 1.0.0's write-order guard compared (block, logIndex) and left every one of
// those 13 multi-transaction keys on a non-final write (10 of them with a
// different value), on the stream and again after the reconcile re-read the
// blocks. Everything below is the shipped code: the real component registry
// and its id mappings (as daemon.ts builds them), the real decoder,
// createStream with its continuity check and reconcile, the real range
// reader and its batch proof, healRange, and applyNetworkUpdates.

import { keccak256 } from '@mud-classic/utils';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';

import type { StreamResponse } from 'clients/kamigaze';
import { createDecode } from 'engine/encoders';
import { createWorld, getComponentValue, type Component, type Schema } from 'engine/recs';
import { formatComponentID, formatEntityID } from 'engine/utils';
import { createComponents } from 'network/components';
import { applyNetworkUpdates } from 'network/setup';
import { resetSyncHealth, syncHealth } from '../src/sync-health';
import { Ack } from 'workers/sync';
import { createStream, markerEvent } from 'workers/sync/stream';
import { NetworkEvent } from 'workers/types';
import {
  emptyFrame,
  iface,
  rawLogProvider,
  reader,
  scriptedClient,
  WORLD,
  type RpcLogJson,
} from './support/chain';

const load = (file: string) =>
  (
    JSON.parse(readFileSync(path.resolve(__dirname, 'fixtures', file), 'utf8')) as {
      result: RpcLogJson[];
    }
  ).result;
const LOGS_A = load('multi_tx_block_a.json');
const LOGS_B = load('multi_tx_block_b.json');
const LOGS = [...LOGS_A, ...LOGS_B];

const n = (x: string) => parseInt(x, 16);
const BLOCK_A = n(LOGS_A[0]!.blockNumber);
const BLOCK_B = n(LOGS_B[0]!.blockNumber);

/** One log, parsed once: its chain position, its key, and what it wrote. */
type Parsed = {
  block: number;
  tx: number;
  logIndex: number;
  component: string;
  entity: string;
  key: string;
  removed: boolean;
  /** the component value's ABI bytes (a set), as a stream frame carries them */
  bytes?: Uint8Array;
  txHash: string;
};

const PARSED: Parsed[] = LOGS.map((l) => {
  const p = iface.parseLog({ topics: l.topics, data: l.data })!;
  const component = formatComponentID(p.args.componentId as string);
  const entity = formatEntityID(p.args.entity as string);
  const removed = p.name === 'ComponentValueRemoved';
  return {
    block: n(l.blockNumber),
    tx: n(l.transactionIndex),
    logIndex: n(l.logIndex),
    component,
    entity,
    key: `${component}|${entity}`,
    removed,
    ...(removed ? {} : { bytes: Buffer.from((p.args.data as string).slice(2), 'hex') }),
    txHash: l.transactionHash,
  };
}).sort((a, b) => a.block - b.block || a.tx - b.tx || a.logIndex - b.logIndex);

const inBlock = (block: number) => PARSED.filter((p) => p.block === block);
const lastTx = (block: number) => Math.max(...inBlock(block).map((p) => p.tx));

/** Chain truth: each key's LAST write, by (block, transaction, index). */
function chainTruth(decode: ReturnType<typeof createDecode>) {
  const last = new Map<string, Parsed>();
  for (const p of PARSED) last.set(p.key, p);
  return new Map(
    [...last].map(([k, p]) => [k, p.removed ? undefined : decode(p.component, p.bytes!)])
  );
}

/** What 1.0.0's rule — skip unless (block, logIndex) is strictly newer — left
 * a block's keys on, compared with the block's final write per key. */
function oldRuleOn(block: number) {
  const kept = new Map<string, Parsed>();
  const last = new Map<string, Parsed>();
  for (const p of inBlock(block)) {
    last.set(p.key, p);
    const k = kept.get(p.key);
    if (k === undefined || p.logIndex > k.logIndex) kept.set(p.key, p);
  }
  const nonFinal = [...last.keys()].filter((k) => kept.get(k) !== last.get(k));
  return {
    nonFinal: nonFinal.length,
    lowerIndex: nonFinal.filter((k) => last.get(k)!.logIndex < kept.get(k)!.logIndex).length,
    equalIndex: nonFinal.filter((k) => last.get(k)!.logIndex === kept.get(k)!.logIndex).length,
  };
}

/** The frame Kamigaze sends for one log: its own (block, logIndex), the
 * previous frame as prev pointer, no transaction index. */
function frameOf(p: Parsed, prev: { block: number; logIndex: number }): StreamResponse {
  return {
    blockNumber: p.block,
    logIndex: p.logIndex,
    prevBlockNumber: prev.block,
    prevLogBlockNumber: prev.block,
    prevLogIndex: prev.logIndex,
    blockTimestamp: 0,
    blockHash: '',
    transactionsConfirmed: [],
    ecsEvents: [
      {
        eventType: p.removed ? 'ComponentValueRemoved' : 'ComponentValueSet',
        componentId: p.component,
        entityId: p.entity,
        txHash: p.txHash,
        ...(p.removed ? {} : { value: p.bytes }),
      },
    ],
  } as unknown as StreamResponse;
}

/** Frames for `delivered`, in chain order, chained to each other — what a
 * server that delivered exactly these sends, so the continuity check sees no
 * gap — then one empty frame in the block after B, which moves the stream's
 * cursor past both blocks. */
function streamOf(delivered: Parsed[]): StreamResponse[] {
  let prev = { block: BLOCK_A - 1, logIndex: 0 };
  const frames = delivered.map((p) => {
    const f = frameOf(p, prev);
    prev = { block: p.block, logIndex: p.logIndex };
    return f;
  });
  frames.push(emptyFrame({ block: BLOCK_B + 1, logIndex: 0 }, prev));
  return frames;
}

async function until(cond: () => boolean, ms = 3_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Run both blocks through the stream (`delivered` of their logs), snapshot
 * the mirror, then let the periodic reconcile re-read them from the chain. */
async function replay(delivered: Parsed[]) {
  resetSyncHealth();
  const decode = createDecode();
  const world = createWorld();
  const components = createComponents(world);
  const mappings: Record<string, string> = {};
  for (const [key, c] of Object.entries(components)) {
    const contractId = (c as { metadata?: { contractId?: string } }).metadata?.contractId;
    if (contractId) mappings[keccak256(contractId)] = key;
  }
  const ecsEvents$ = new Subject<NetworkEvent[]>();
  applyNetworkUpdates(world, components, ecsEvents$ as never, mappings as never, new Subject<Ack>());
  // the bootstrap fill covered everything before block A
  ecsEvents$.next([markerEvent({ anchor: null, through: BLOCK_A - 1 }) as NetworkEvent]);

  const read = () =>
    new Map(
      [...chainTruth(decode).keys()].map((k) => {
        const [component, entity] = k.split('|') as [string, string];
        const idx = world.entityToIndex.get(entity as never);
        const c = (components as unknown as Record<string, Component<Schema>>)[mappings[component]!]!;
        return [k, idx === undefined ? undefined : getComponentValue(c, idx)];
      })
    );

  const reconcileFrom$ = new Subject<{ baseline: number; frontier: number }>();
  const provider = rawLogProvider(LOGS, () => BLOCK_B + 5);
  let empties = 0;
  const sub = createStream({
    url: 'http://fake',
    worldAddress: WORLD,
    decode,
    includeSystemCalls: false,
    fetchWorldEvents: reader(provider),
    rpcHead: { cached: () => BLOCK_B + 5, fetch: async () => BLOCK_B + 5 },
    createClient: () => scriptedClient(streamOf(delivered)),
    timeoutMs: 30_000,
    reconcileFrom$,
    reconcileIntervalMs: 60_000, // no periodic tick inside the test
    reconcileCatchUpGapMs: 5,
    reconcilePaceMs: 0,
  }).subscribe((e) => {
    if ((e as { txHash?: string }).txHash === 'EmptyNetworkEvent') empties++;
    ecsEvents$.next([e as NetworkEvent]);
  });

  // (i) the stream: every delivered frame, then the empty frame after B
  await until(() => empties > 0);
  const streamed = read();

  // (ii) the reconcile: seeded below block A, its pass reads
  // [A, B + 1] through the real reader and healRange
  reconcileFrom$.next({ baseline: BLOCK_A - 1, frontier: BLOCK_A - 1 });
  await until(() => (syncHealth.reconciledThrough ?? 0) >= BLOCK_B + 1);
  const reconciled = read();
  sub.unsubscribe();
  world.dispose();
  return { truth: chainTruth(decode), streamed, reconciled, provider };
}

const differing = (a: Map<string, unknown>, b: Map<string, unknown>) =>
  [...a.keys()].filter((k) => JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k)));

describe('1.0.1: two real multi-transaction blocks, replayed', () => {
  beforeEach(() => resetSyncHealth());

  it('the fixtures: per-transaction indices, several transactions per key, lower AND equal index cases', () => {
    expect(BLOCK_B).toBe(BLOCK_A + 1);
    const shape = (block: number) => {
      const logs = inBlock(block);
      const perTx = new Map<number, number>();
      for (const p of logs) perTx.set(p.tx, (perTx.get(p.tx) ?? 0) + 1);
      const keys = new Map<string, Set<number>>();
      for (const p of logs) keys.set(p.key, (keys.get(p.key) ?? new Set()).add(p.tx));
      return {
        logs: logs.length,
        perTx: [...perTx.values()],
        distinctIndices: new Set(logs.map((p) => p.logIndex)).size,
        positions: new Set(logs.map((p) => `${p.tx}/${p.logIndex}`)).size,
        keys: keys.size,
        multiTx: [...keys.values()].filter((t) => t.size > 1).length,
      };
    };
    expect(shape(BLOCK_A)).toEqual({
      logs: 44,
      perTx: [16, 7, 7, 7, 7],
      distinctIndices: 16,
      positions: 44,
      keys: 16,
      multiTx: 7,
    });
    expect(shape(BLOCK_B)).toEqual({
      logs: 27,
      perTx: [9, 9, 9],
      distinctIndices: 9,
      positions: 27,
      keys: 12,
      multiTx: 6,
    });
    // what the 1.0.0 rule did to them: every multi-transaction key non-final
    expect(oldRuleOn(BLOCK_A)).toEqual({ nonFinal: 7, lowerIndex: 6, equalIndex: 1 });
    expect(oldRuleOn(BLOCK_B)).toEqual({ nonFinal: 6, lowerIndex: 0, equalIndex: 6 });
  });

  it('every frame of both blocks, in chain order: the STREAM alone lands every key on its final write; the reconcile repairs nothing', async () => {
    const { truth, streamed, reconciled } = await replay(PARSED);
    expect(truth.size).toBe(28);
    expect.soft(differing(streamed, truth), 'keys wrong after the stream').toEqual([]);
    expect.soft(differing(reconciled, truth), 'keys wrong after the reconcile').toEqual([]);
    expect(syncHealth.reconcileRepairs).toBe(0);
    expect(syncHealth.lastRepair).toBeUndefined();
  });

  it.each([
    ['A', () => BLOCK_A, 7, 5],
    ['B', () => BLOCK_B, 9, 7],
  ])(
    'the stream loses block %s s last transaction unseen: the reconcile lands every key, and counts each one it changed',
    async (_name, block, frames, wrongKeys) => {
      const b = block();
      const lost = PARSED.filter((p) => p.block === b && p.tx === lastTx(b));
      expect(lost).toHaveLength(frames);
      const { truth, streamed, reconciled } = await replay(PARSED.filter((p) => !lost.includes(p)));
      const wrong = differing(streamed, truth);
      expect(wrong).toHaveLength(wrongKeys);
      expect(differing(reconciled, truth)).toEqual([]);
      expect(syncHealth.reconcileRepairs).toBe(wrong.length);
      expect(syncHealth.lastRepair).toMatchObject({ block: b });
    }
  );
});
