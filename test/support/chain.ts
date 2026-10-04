// A small model chain for hermetic sync tests: World logs as the public RPC
// returns them, served by a fake JSON-RPC provider that behaves the way the
// endpoint was MEASURED to behave (2026-10-03): a pool of backends at
// different heads; a single request may land on any of them; a JSON-RPC batch
// is ONE request served by ONE backend; a backend clamps `toBlock` to its own
// head and answers short with no error. The provider answers both the ethers
// `getLogs` path and the raw batch `_send`, so the real range reader
// (createFetchWorldEventsInBlockRange) runs unmodified against it.
//
// 1.0.1: LOGS ARE NUMBERED PER TRANSACTION, as Yominet numbers them. A log's
// `logIndex` restarts in every transaction (a real five-transaction block: 44
// World logs indexed 1..16, then 1..7 four times — 16 distinct indices), so
// a log's place in its block is (transactionIndex, logIndex) and never
// logIndex alone. Until 1.0.1 this helper put every log at transactionIndex 0
// and every fixture gave each block at most one log, so no hermetic test ever
// had two transactions write one key in one block — which is how the 1.0.0
// write-order guard passed every test while dropping such writes live.

import { AbiCoder, Interface } from 'ethers';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { StreamResponse } from 'clients/kamigaze';
import { createDecode } from 'engine/encoders';
import type { StreamClient } from 'workers/sync/stream';
import { createFetchWorldEventsInBlockRange } from 'workers/sync/utils';

export const WORLD = '0x2729174c265dbBd8416C6449E0E813E88f43D0E7';
const abi = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../src/abi/World.json'), 'utf8')
).abi as unknown[];
export const iface = new Interface(abi as never);

/** A component whose schema the decoder knows (uint32[]), so a
 * ComponentValueSet log round-trips through the real decode. */
export const COMPONENT_ID = '0xb3f96e7944f99619a1086b9a1272bbdff635f1cac9c8bf7ba6ce1a9aa202f19c';

/** One World log: a set (value) or a removal (no value).
 *
 * `tx` is the log's TRANSACTION INDEX within its block, and `logIndex` its
 * index WITHIN THAT TRANSACTION — the chain's own numbering (see the banner).
 * The transaction hash is derived from (block, tx). */
export type ChainLog = { block: number; logIndex: number; tx: number; entity: bigint; value?: number[] };

export const encodeValue = (value: number[]) =>
  AbiCoder.defaultAbiCoder().encode(['uint32[]'], [value]);

/** The transaction hash of the `tx`-th transaction of `block`. */
export const txHashOf = (l: Pick<ChainLog, 'block' | 'tx'>) =>
  `0x${l.block.toString(16).padStart(32, '0')}${l.tx.toString(16).padStart(32, '0')}`;

/** Chain order: block, then transaction, then the log's index in it. */
export const chainOrder = (a: ChainLog, b: ChainLog) =>
  a.block - b.block || a.tx - b.tx || a.logIndex - b.logIndex;

/** A fixture is numbered the chain's way: no two logs share a
 * (block, transaction, index) position. Throws on a fixture that is not. */
export function assertPerTransactionNumbering(chain: ChainLog[]): void {
  const seen = new Set<string>();
  for (const l of chain) {
    const k = `${l.block}/${l.tx}/${l.logIndex}`;
    if (seen.has(k)) throw new Error(`two logs at (block, tx, logIndex) = (${k.replace(/\//g, ', ')})`);
    seen.add(k);
  }
}

/** A log as ethers' getLogs returns it AND as the raw JSON-RPC wire carries it. */
export function encodeLog(l: ChainLog) {
  const { topics, data } =
    l.value === undefined
      ? iface.encodeEventLog('ComponentValueRemoved', [
          BigInt(COMPONENT_ID),
          '0x000000000000000000000000000000000000c0de',
          l.entity,
        ])
      : iface.encodeEventLog('ComponentValueSet', [
          BigInt(COMPONENT_ID),
          '0x000000000000000000000000000000000000c0de',
          l.entity,
          encodeValue(l.value),
        ]);
  const transactionHash = txHashOf(l);
  return {
    ethers: {
      address: WORLD,
      topics,
      data,
      blockNumber: l.block,
      transactionIndex: l.tx,
      index: l.logIndex,
      transactionHash,
    },
    wire: {
      address: WORLD.toLowerCase(),
      topics,
      data,
      blockNumber: `0x${l.block.toString(16)}`,
      transactionIndex: `0x${l.tx.toString(16)}`,
      logIndex: `0x${l.logIndex.toString(16)}`,
      transactionHash,
      blockHash: `0x${l.block.toString(16).padStart(64, '0')}`,
      removed: false,
    },
  };
}

/** The measured endpoint. `route.single()` is the head of the backend a single
 * request lands on; `route.batch()` the one a whole batch lands on. Counts
 * the requests it served. */
export function poolProvider(
  chain: ChainLog[],
  route: { single: () => number; batch: () => number }
) {
  assertPerTransactionNumbering(chain);
  // a node answers in chain order (block, transaction, log)
  const logsFor = (head: number, from: number, to: number) =>
    chain
      .filter((l) => l.block >= from && l.block <= Math.min(to, head))
      .sort(chainOrder)
      .map(encodeLog);
  const n = (x: unknown) => (typeof x === 'string' ? parseInt(x, 16) : Number(x));
  const served = { batches: 0, singles: 0 };
  return {
    served,
    _getFilter: (f: unknown) => f,
    getLogs: async (f: { fromBlock: unknown; toBlock: unknown }) => {
      served.singles++;
      return logsFor(route.single(), n(f.fromBlock), n(f.toBlock)).map((l) => l.ethers);
    },
    getBlockNumber: async () => {
      served.singles++;
      return route.single();
    },
    _send: async (payload: unknown) => {
      served.batches++;
      const calls = (Array.isArray(payload) ? payload : [payload]) as {
        id: number;
        method: string;
        params: { fromBlock: string; toBlock: string }[];
      }[];
      const head = route.batch(); // one HTTP request, one backend
      return calls.map((c) =>
        c.method === 'eth_blockNumber'
          ? { jsonrpc: '2.0', id: c.id, result: `0x${head.toString(16)}` }
          : c.method === 'eth_getLogs'
            ? {
                jsonrpc: '2.0',
                id: c.id,
                result: logsFor(head, n(c.params[0]!.fromBlock), n(c.params[0]!.toBlock)).map(
                  (l) => l.wire
                ),
              }
            : { jsonrpc: '2.0', id: c.id, error: { code: -32601, message: 'unsupported' } }
      );
    },
  };
}

/** The real range reader over a provider. */
export const reader = (provider: unknown) =>
  createFetchWorldEventsInBlockRange(
    provider as never,
    { address: WORLD, abi: iface } as never,
    false,
    createDecode()
  );

/** Chain truth: each entity's value after every log through `through`
 * (undefined = removed / never set). */
export function truthAt(chain: ChainLog[], through: number, initial: Map<bigint, number[] | undefined>) {
  const out = new Map(initial);
  const logs = chain.filter((l) => l.block <= through).sort(chainOrder);
  for (const l of logs) out.set(l.entity, l.value);
  return out;
}

// ------------------------------------------------ the stream side (1.0.1)

/** The stream frame Kamigaze sends for one log: one event, the log's own
 * (block, logIndex) — its index WITHIN ITS TRANSACTION, as on the chain — and
 * the previous frame's (block, logIndex) as its prev pointer. A frame
 * carries no transaction index. */
export function frameFor(
  l: ChainLog,
  prev: { block: number; logIndex: number }
): StreamResponse {
  return {
    blockNumber: l.block,
    logIndex: l.logIndex,
    prevBlockNumber: prev.block,
    prevLogBlockNumber: prev.block,
    prevLogIndex: prev.logIndex,
    blockTimestamp: 0,
    blockHash: '',
    transactionsConfirmed: [],
    ecsEvents: [
      {
        eventType: l.value === undefined ? 'ComponentValueRemoved' : 'ComponentValueSet',
        componentId: COMPONENT_ID,
        entityId: `0x${l.entity.toString(16)}`,
        txHash: txHashOf(l),
        ...(l.value === undefined
          ? {}
          : { value: Buffer.from(encodeValue(l.value).slice(2), 'hex') }),
      },
    ],
  } as unknown as StreamResponse;
}

/** A frame that carries no event (a position marker / keepalive), chained to
 * `prev` — what moves the stream's cursor into a block with no logs. */
export function emptyFrame(
  at: { block: number; logIndex: number },
  prev: { block: number; logIndex: number }
): StreamResponse {
  return {
    blockNumber: at.block,
    logIndex: at.logIndex,
    prevBlockNumber: prev.block,
    prevLogBlockNumber: prev.block,
    prevLogIndex: prev.logIndex,
    blockTimestamp: 0,
    blockHash: '',
    transactionsConfirmed: [],
    ecsEvents: [],
  } as unknown as StreamResponse;
}

/** Frames for `logs`, in the order given, each chained to the one before it
 * — exactly what a server that delivered these and nothing else would send,
 * so the client's continuity check sees no gap. `start` is the first frame's
 * prev pointer. */
export function framesFor(
  logs: ChainLog[],
  start: { block: number; logIndex: number }
): StreamResponse[] {
  let prev = start;
  return logs.map((l) => {
    const f = frameFor(l, prev);
    prev = { block: l.block, logIndex: l.logIndex };
    return f;
  });
}

/** A scripted subscribeToStream. A step is a frame, or a promise the script
 * waits on before going on (to hold the rest of a block back). After the last
 * step the subscription stays open. */
export function scriptedClient(steps: (StreamResponse | Promise<unknown>)[]): StreamClient {
  return {
    subscribeToStream: ((_req: unknown, opts?: { signal?: AbortSignal }) =>
      (async function* () {
        for (const step of steps) {
          if (opts?.signal?.aborted) return;
          if (step instanceof Promise) {
            await step;
            continue;
          }
          await new Promise((r) => setTimeout(r, 1));
          yield step;
        }
        await new Promise(() => {});
      })()) as StreamClient['subscribeToStream'],
    getEventsSince: (async () => ({ events: [], latestBlock: 0 })) as never,
  };
}

// ------------------------------------------- raw chain logs (fixtures, 1.0.1)

/** A log exactly as `eth_getLogs` returns it on the wire. */
export type RpcLogJson = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  logIndex: string;
  removed: boolean;
};

/** A batch-capable provider over REAL logs as `eth_getLogs` returned them,
 * every backend at `head()`. Answers in chain order. */
export function rawLogProvider(logs: RpcLogJson[], head: () => number) {
  const n = (x: string) => parseInt(x, 16);
  const ordered = [...logs].sort(
    (a, b) =>
      n(a.blockNumber) - n(b.blockNumber) ||
      n(a.transactionIndex) - n(b.transactionIndex) ||
      n(a.logIndex) - n(b.logIndex)
  );
  const served = { batches: 0 };
  return {
    served,
    getBlockNumber: async () => head(),
    _send: async (payload: unknown) => {
      served.batches++;
      const calls = (Array.isArray(payload) ? payload : [payload]) as {
        id: number;
        method: string;
        params: { fromBlock: string; toBlock: string }[];
      }[];
      const h = head();
      return calls.map((c) =>
        c.method === 'eth_blockNumber'
          ? { jsonrpc: '2.0', id: c.id, result: `0x${h.toString(16)}` }
          : c.method === 'eth_getLogs'
            ? {
                jsonrpc: '2.0',
                id: c.id,
                result: ordered.filter((l) => {
                  const b = n(l.blockNumber);
                  return b >= n(c.params[0]!.fromBlock) && b <= Math.min(n(c.params[0]!.toBlock), h);
                }),
              }
            : { jsonrpc: '2.0', id: c.id, error: { code: -32601, message: 'unsupported' } }
      );
    },
  };
}
