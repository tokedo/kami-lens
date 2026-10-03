// A small model chain for hermetic sync tests: World logs as the public RPC
// returns them, served by a fake JSON-RPC provider that behaves the way the
// endpoint was MEASURED to behave (2026-10-03): a pool of backends at
// different heads; a single request may land on any of them; a JSON-RPC batch
// is ONE request served by ONE backend; a backend clamps `toBlock` to its own
// head and answers short with no error. The provider answers both the ethers
// `getLogs` path and the raw batch `_send`, so the real range reader
// (createFetchWorldEventsInBlockRange) runs unmodified against it.

import { AbiCoder, Interface } from 'ethers';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createDecode } from 'engine/encoders';
import { createFetchWorldEventsInBlockRange } from 'workers/sync/utils';

export const WORLD = '0x2729174c265dbBd8416C6449E0E813E88f43D0E7';
const abi = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../src/abi/World.json'), 'utf8')
).abi as unknown[];
export const iface = new Interface(abi as never);

/** A component whose schema the decoder knows (uint32[]), so a
 * ComponentValueSet log round-trips through the real decode. */
export const COMPONENT_ID = '0xb3f96e7944f99619a1086b9a1272bbdff635f1cac9c8bf7ba6ce1a9aa202f19c';

/** One World log: a set (value) or a removal (no value). */
export type ChainLog = { block: number; logIndex: number; tx: number; entity: bigint; value?: number[] };

export const encodeValue = (value: number[]) =>
  AbiCoder.defaultAbiCoder().encode(['uint32[]'], [value]);

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
  const transactionHash = `0x${l.tx.toString(16).padStart(64, '0')}`;
  return {
    ethers: {
      address: WORLD,
      topics,
      data,
      blockNumber: l.block,
      transactionIndex: 0,
      index: l.logIndex,
      transactionHash,
    },
    wire: {
      address: WORLD.toLowerCase(),
      topics,
      data,
      blockNumber: `0x${l.block.toString(16)}`,
      transactionIndex: '0x0',
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
  const logsFor = (head: number, from: number, to: number) =>
    chain.filter((l) => l.block >= from && l.block <= Math.min(to, head)).map(encodeLog);
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
  const logs = chain
    .filter((l) => l.block <= through)
    .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  for (const l of logs) out.set(l.entity, l.value);
  return out;
}
