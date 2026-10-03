/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/workers/sync/utils.ts
 * changes:  type-hole fixes only (upstream is vite-transpiled and never
 *           typechecked; no behavior change):
 *           - createWorldTopics types its contract map as
 *             { World: World & Contract } — the bare typechain World does
 *             not satisfy the Contracts index-signature constraint;
 *           - (until 1.0.0) fetchEventsInBlockRange received `provider as
 *             JsonRpcProvider`; the 1.0.0 range reader below talks to the
 *             provider's raw `_send` instead and no longer calls it.
 *           Hygiene divergence (DESIGN §4.1, decision 2026-07-20): an
 *           undecodable state row is skipped, counted
 *           (tripwires.decodeFailures, incremented inside createDecode) and
 *           logged with component/entity/bytes instead of aborting the sync
 *           attempt — upstream crashes the whole load on one bad row.
 *           Divergence (DESIGN §4.1, 2026-09-06, "L-1"):
 *           fetchEventsInBlockRangeChunked fetches a NON-NEGATIVE range
 *           always. Upstream derives its step count from the EXCLUSIVE delta
 *           (`ceil((to - from) / interval)`), so `from === to` yields zero
 *           steps and the function returns [] having read nothing — while its
 *           own doc comment and every caller treat the range as inclusive.
 *           That is the same-block gap the stream opens most often (one chunk
 *           per log; 136 of 17,369 gap-fills over 11 days had from === to),
 *           and the RPC fallback silently healed none of them. The count is
 *           now taken from the INCLUSIVE span, and the progress fraction no
 *           longer divides by that delta — it was 0/0 = NaN on a one-block
 *           range, and Worker.ts pipes setPercentage straight into the
 *           LoadingState component (§3.14: a non-finite value must never
 *           reach the serialization boundary).
 *           1.0.0 (A2), the range reader PROVES what it read. The public RPC
 *           is a per-request balanced pool whose backends clamp `toBlock` to
 *           their own head and answer short with no error; a head proven on
 *           one request said nothing about the backend that served the logs
 *           (measured 2026-10-03: 23 of 900 such reads short, every one
 *           against a proven head at or past the range end). A JSON-RPC
 *           batch is ONE request and is served by ONE backend (300 batches
 *           of four eth_blockNumber never disagreed; 19 of 19 short batched
 *           reads carried their own head below the range end, with every
 *           missing log above it). So createFetchWorldEventsInBlockRange
 *           now sends [eth_blockNumber, eth_getLogs, eth_blockNumber] as one
 *           batch through the provider's raw `_send`, accepts it only if all
 *           three answered, h1 <= h2 and no log lies above h1 (a split batch
 *           would trip one of those), and reports `provenThrough =
 *           min(to, h1 - PROOF_MARGIN_BLOCKS)` on the returned array. And
 *           every event keeps its REAL block and its log index — upstream
 *           stamped every event of a range with the range END and dropped
 *           the index, so nothing downstream could order a re-read against
 *           what was already applied (A2(c)).
 */

import { awaitPromise, range, to256BitString } from '@mud-classic/utils';
import { abi as worldAbi } from 'abi/World.json';
import { Components, EntityID } from 'engine/recs';
import { Contract, Interface, JsonRpcProvider, Provider } from 'ethers';
import { log } from 'utils/logger';
import { Observable, concatMap, map, of } from 'rxjs';
import { World } from 'types/ethers-contracts';

import { createDecode } from 'engine/encoders';
import { ECSStateReplyV2, ECSStateSnapshotServiceClient } from 'engine/types/ecs-snapshot';
import { formatComponentID, formatEntityID } from 'engine/utils';
import { uint8ArrayToHexString } from 'utils/numbers';
import { ContractConfig } from 'workers/types';
import { debug as parentDebug } from '../debug';
import {
  NetworkComponentUpdate,
  NetworkEvent,
  NetworkEvents,
  SystemCall,
  SystemCallTransaction,
} from '../types';
import { createTopics } from './evm';
import { StateCache, createStateCache, storeStateEvent } from './state';

const debug = parentDebug.extend('syncUtils');

/**
 * Load from the remote snapshot service in chunks via a stream.
 *
 * @param snapshotClient ECSStateSnapshotServiceClient
 * @param worldAddress Address of the World contract to get the snapshot for.
 * @param decode Function to decode raw component values ({@link createDecode}).
 * @returns Promise resolving with {@link StateCache} containing the snapshot state.
 */
export async function fetchSnapshotChunked(
  snapshotClient: ECSStateSnapshotServiceClient,
  worldAddress: string,
  decode: ReturnType<typeof createDecode>,
  numChunks = 10,
  setPercentage?: (percentage: number) => void,
  pruneOptions?: { playerAddress: string; hashedComponentId: string }
): Promise<StateCache> {
  const stateCache = createStateCache();
  const chunkPercentage = Math.ceil(100 / numChunks);

  try {
    const response = pruneOptions
      ? snapshotClient.getStateLatestStreamPrunedV2({
          worldAddress,
          chunkPercentage,
          pruneAddress: pruneOptions?.playerAddress,
          pruneComponentId: pruneOptions?.hashedComponentId,
        })
      : snapshotClient.getStateLatestStreamV2({
          worldAddress,
          chunkPercentage,
        });

    let i = 0;
    for await (const responseChunk of response) {
      reduceFetchedState(responseChunk, stateCache, decode);
      setPercentage && setPercentage((i++ / numChunks) * 100);
    }
  } catch (e) {
    console.error(e);
  }

  return stateCache;
}

/**
 * Reduces a snapshot response by storing corresponding ECS events into the cache store.
 *
 * @param response ECSStateReplyV2
 * @param stateCache {@link StateCache} to store snapshot state into.
 * @param decode Function to decode raw component values ({@link createDecode}).
 */
export function reduceFetchedState(
  response: ECSStateReplyV2,
  stateCache: StateCache,
  decode: ReturnType<typeof createDecode>
): void {
  const { state, blockNumber, stateComponents, stateEntities } = response;
  const stateEntitiesHex = stateEntities.map((e) => uint8ArrayToHexString(e) as EntityID);
  const stateComponentsHex = stateComponents.map((e) => to256BitString(e));

  for (const { componentIdIdx, entityIdIdx, value: rawValue } of state) {
    const component = stateComponentsHex[componentIdIdx]!;
    const entity = stateEntitiesHex[entityIdIdx]!;
    if (entity == undefined) debug('invalid entity index', stateEntities.length, entityIdIdx);
    const value = decode(component, rawValue);
    storeStateEvent(stateCache, {
      type: NetworkEvents.NetworkComponentUpdate,
      component,
      entity,
      value,
      blockNumber,
    });
  }
}

/**
 * Create a RxJS stream of {@link NetworkComponentUpdate}s by listening to new
 * blocks from the blockNumber$ stream and fetching the corresponding block
 * from the connected RPC.
 *
 * @dev Only use if {@link createLatestEventStreamService} is not available.
 *
 * @param blockNumber$ Block number stream
 * @param fetchWorldEvents Function to fetch World events in a block range ({@link createFetchWorldEventsInBlockRange}).
 * @returns Stream of {@link NetworkComponentUpdate}s.
 */
export function createLatestEventStreamRPC(
  blockNumber$: Observable<number>,
  fetchWorldEvents: ReturnType<typeof createFetchWorldEventsInBlockRange>,
  fetchSystemCallsFromEvents?: ReturnType<typeof createFetchSystemCallsFromEvents>
): Observable<NetworkEvent> {
  let lastSyncedBlockNumber: number | undefined;
  return blockNumber$.pipe(
    map(async (blockNumber) => {
      const from =
        lastSyncedBlockNumber == null || lastSyncedBlockNumber >= blockNumber
          ? blockNumber
          : lastSyncedBlockNumber + 1;
      const to = blockNumber;
      lastSyncedBlockNumber = to;
      const events = await fetchWorldEvents(from, to);
      // console.log(`[rpc] fetched ${events.length} events from block range ${from} -> ${to}`);

      if (fetchSystemCallsFromEvents && events.length > 0) {
        const systemCalls = await fetchSystemCallsFromEvents(events, blockNumber);
        return [...events, ...systemCalls];
      }

      return events;
    }),
    awaitPromise(),
    concatMap((v) => of(...v))
  );
}

/**
 * Fetch ECS events from contracts in the given block range.
 *
 * @param fetchWorldEvents Function to fetch World events in a block range ({@link createFetchWorldEventsInBlockRange}).
 * @param fromBlockNumber Start of block range (inclusive).
 * @param toBlockNumber End of block range (inclusive).
 * @param interval Chunk fetching the blocks in intervals to avoid overwhelming the client.
 * @returns Promise resolving with array containing the contract ECS events in the given block range.
 */
export async function fetchEventsInBlockRangeChunked(
  fetchWorldEvents: ReturnType<typeof createFetchWorldEventsInBlockRange>,
  fromBlockNumber: number,
  toBlockNumber: number,
  interval = 50,
  setPercentage?: (percentage: number) => void
): Promise<NetworkComponentUpdate<Components>[]> {
  const events: NetworkComponentUpdate<Components>[] = [];
  // INCLUSIVE span, per this function's own contract and every caller's use:
  // [from, to] is `to - from + 1` blocks, so a single-block range is one step
  // rather than none (divergence, see the banner).
  const span = toBlockNumber - fromBlockNumber + 1;
  if (span <= 0) return events;
  const numSteps = Math.ceil(span / interval);
  const steps = [...range(numSteps, interval, fromBlockNumber)];

  for (let i = 0; i < steps.length; i++) {
    const from = steps[i]!;
    const to = i === steps.length - 1 ? toBlockNumber : steps[i + 1]! - 1;
    const chunkEvents = await fetchWorldEvents(from, to);

    // progress over STEPS, not over the block delta: the delta is 0 on a
    // one-block range and 0/0 is NaN (§3.14)
    if (setPercentage) setPercentage(((i + 1) / steps.length) * 100);

    events.push(...chunkEvents);
  }

  return events;
}

/**
 * Create World contract topics for the `ComponentValueSet` and `ComponentValueRemoved` events.
 * @returns World contract topics for the `ComponentValueSet` and `ComponentValueRemoved` events.
 */
export function createWorldTopics() {
  return createTopics<{ World: World & Contract }>({
    World: { abi: new Interface(worldAbi), topics: ['ComponentValueSet', 'ComponentValueRemoved'] },
  });
}

/** K (1.0.0, A2(a)): a batch whose own head is h1 proves its logs answer
 * complete through h1 - K. Measured 2026-10-03, 900 samples: no missing log
 * ever sat at or below the batch's own head, so K = 0 was supported by the
 * data; K = 1 is the margin for a backend whose head runs ahead of its log
 * index, a rare answer 900 samples cannot exclude, against a failure (a
 * silent state regression) that must not happen. It costs one block. */
export const PROOF_MARGIN_BLOCKS = 1;

/** A range read's events, plus what the read PROVES (1.0.0, A2(a)).
 * `provenThrough` is the highest block through which this answer is known
 * complete — below `from` when the batch proved nothing (a lagging backend
 * entirely behind the range, or a split batch). Absent only on a reader
 * that cannot batch (a provider without `_send`), which proves nothing. */
export type ProvenEvents<C extends Components = Components> = NetworkComponentUpdate<C>[] & {
  provenThrough?: number;
  /** the serving backend's own head, h1 */
  batchHead?: number;
};

type RpcLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionIndex: string;
  logIndex: string;
  transactionHash: string;
};

type RpcReply = { id: number; result?: unknown; error?: { code: number; message: string } };

const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 1_000;
let batchId = 0;

/**
 * Create a function to fetch World contract events in a given block range.
 * @param provider ethers Provider
 * @param worldConfig Contract address and interface of the World contract.
 * @param batch Set to true if the provider supports batch queries (recommended).
 * @param decode Function to decode raw component values ({@link createDecode})
 * @returns Function to fetch World contract events in a given block range.
 */
export function createFetchWorldEventsInBlockRange<C extends Components>(
  provider: Provider,
  worldConfig: ContractConfig,
  batch: boolean | undefined,
  decode: ReturnType<typeof createDecode>
) {
  const worldTopics = createWorldTopics().find((t) => t.key === 'World')?.topics ?? [];
  let ifaceMemo: Interface | undefined;
  const iface = () =>
    (ifaceMemo ??=
      worldConfig.abi instanceof Interface ? worldConfig.abi : new Interface(worldConfig.abi as never));
  const send = (provider as JsonRpcProvider)._send?.bind(provider as JsonRpcProvider);

  /** one proven read: [eth_blockNumber, eth_getLogs, eth_blockNumber] */
  const provenRead = async (from: number, to: number) => {
    const ids = [++batchId, ++batchId, ++batchId];
    const payload = [
      { jsonrpc: '2.0', id: ids[0], method: 'eth_blockNumber', params: [] },
      {
        jsonrpc: '2.0',
        id: ids[1],
        method: 'eth_getLogs',
        params: [
          {
            address: worldConfig.address,
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
            topics: worldTopics,
          },
        ],
      },
      { jsonrpc: '2.0', id: ids[2], method: 'eth_blockNumber', params: [] },
    ];
    let lastError: unknown;
    for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
      try {
        const replies = (await send!(payload as never)) as unknown as RpcReply[];
        const byId = new Map(replies.map((r) => [Number(r.id), r]));
        const [r1, r2, r3] = ids.map((id) => byId.get(id));
        for (const r of [r1, r2, r3]) {
          if (!r || r.error || r.result === undefined) {
            throw new Error(`batch read ${from}..${to}: ${r?.error?.message ?? 'missing reply'}`);
          }
        }
        return {
          h1: Number(BigInt(r1!.result as string)),
          h2: Number(BigInt(r3!.result as string)),
          logs: r2!.result as RpcLog[],
        };
      } catch (e) {
        lastError = e;
        if (attempt < READ_ATTEMPTS) await new Promise((r) => setTimeout(r, READ_RETRY_MS));
      }
    }
    throw lastError;
  };

  const toEvents = async (
    logs: { log: RpcLog; block: number; txIndex: number; index: number }[]
  ): Promise<NetworkComponentUpdate<C>[]> => {
    logs.sort((a, b) => a.block - b.block || a.txIndex - b.txIndex || a.index - b.index);
    const ecsEvents: NetworkComponentUpdate<C>[] = [];
    for (let i = 0; i < logs.length; i++) {
      const { log: raw, block, index } = logs[i]!;
      let parsed: ReturnType<Interface['parseLog']>;
      try {
        parsed = iface().parseLog({ topics: raw.topics, data: raw.data });
      } catch (e) {
        console.warn("A log couldn't be parsed with the corresponding contract interface!", e);
        continue;
      }
      if (!parsed) continue;
      const { entity: entityId, data, componentId: rawComponentId } = parsed.args as unknown as {
        entity: string;
        data: string;
        componentId: string;
      };
      const component = formatComponentID(rawComponentId);
      const entity = formatEntityID(entityId);
      const ecsEvent = {
        type: NetworkEvents.NetworkComponentUpdate,
        component,
        entity,
        value: undefined,
        // 1.0.0 (A2(c)): the log's OWN block and index, never the range end
        blockNumber: block,
        logIndex: index,
        lastEventInTx: logs[i + 1]?.log.transactionHash !== raw.transactionHash,
        txHash: raw.transactionHash,
      } as NetworkComponentUpdate<C>;
      if (parsed.name === 'ComponentValueRemoved') ecsEvents.push(ecsEvent);
      if (parsed.name === 'ComponentValueSet') {
        try {
          const value = decode(component, data);
          ecsEvents.push({ ...ecsEvent, value });
        } catch (e) {
          // hygiene divergence: skip undecodable row (counted in createDecode)
          console.warn('[rpc] skipping undecodable row', {
            component,
            entity,
            dataHex: data,
            error: String(e),
          });
        }
      }
    }
    return ecsEvents;
  };

  // Fetches World events in the provided block range (including from and to)
  return async (from: number, to: number): Promise<ProvenEvents<C>> => {
    if (!send) {
      // every provider the daemon builds is an ethers JsonRpcProvider, which
      // has `_send`; one that cannot batch cannot prove a read
      throw new Error('range reader needs a JSON-RPC provider with a batch _send (1.0.0, A2(a))');
    }
    const { h1, h2, logs } = await provenRead(from, to);
    const positioned = logs.map((l) => ({
      log: l,
      block: Number(BigInt(l.blockNumber)),
      txIndex: Number(BigInt(l.transactionIndex)),
      index: Number(BigInt(l.logIndex)),
    }));
    const split = h1 > h2 || positioned.some((l) => l.block > h1);
    const events = (await toEvents(positioned)) as ProvenEvents<C>;
    events.batchHead = h1;
    events.provenThrough = split ? from - 1 : Math.min(to, h1 - PROOF_MARGIN_BLOCKS);
    if (split) {
      log.warn(`[rpc] batch ${from}..${to} looked split across backends (h1=${h1} h2=${h2}) — proves nothing`);
    }
    return events;
  };
}

export function createFetchSystemCallsFromEvents(provider: Provider) {
  const { fetchBlock, clearBlock } = createBlockCache(provider);

  // fetch the call data of a transaction by its hash/block number
  // used for event logging when streamer is unavailable
  const fetchSystemCallData = async (txHash: string, blockNumber: number) => {
    const block = await fetchBlock(blockNumber);
    if (!block) return;
    const tx = block.prefetchedTransactions.find((tx) => tx.hash === txHash);
    if (!tx) return;

    return {
      to: tx.to,
      data: tx.data,
      value: tx.value,
      hash: tx.hash,
    } as SystemCallTransaction;
  };

  return async (events: NetworkComponentUpdate[], blockNumber: number) => {
    const systemCalls: SystemCall[] = [];
    const transactionHashToEvents = groupByTxHash(events);

    const txData = await Promise.all(
      Object.keys(transactionHashToEvents).map((hash) => fetchSystemCallData(hash, blockNumber))
    );
    clearBlock(blockNumber);

    for (const tx of txData) {
      if (!tx) continue;

      systemCalls.push({
        type: NetworkEvents.SystemCall,
        tx,
        updates: transactionHashToEvents[tx.hash]!,
      });
    }

    return systemCalls;
  };
}

function createBlockCache(provider: Provider) {
  const blocks: Record<number, Awaited<ReturnType<typeof provider.getBlock>>> = {};

  return {
    fetchBlock: async (blockNumber: number) => {
      if (blocks[blockNumber]) return blocks[blockNumber];

      const block = await provider.getBlock(blockNumber, true); // prefetch transactions
      blocks[blockNumber] = block;

      return block;
    },
    clearBlock: (blockNumber: number) => delete blocks[blockNumber],
  };
}

// /**
//  * Fetch ECS state from contracts in the given block range.
//  *
//  * @param fetchWorldEvents Function to fetch World events in a block range ({@link createFetchWorldEventsInBlockRange}).
//  * @param fromBlockNumber Start of block range (inclusive).
//  * @param toBlockNumber End of block range (inclusive).
//  * @param interval Chunk fetching the blocks in intervals to avoid overwhelming the client.
//  * @returns Promise resolving with {@link StateCache} containing the contract ECS state in the given block range.
//  */
// export async function fetchStateInBlockRange(
//   fetchWorldEvents: ReturnType<typeof createFetchWorldEventsInBlockRange>,
//   fromBlockNumber: number,
//   toBlockNumber: number,
//   interval = 50,
//   setPercentage?: (percentage: number) => void
// ): Promise<StateCache> {
//   const stateCache = createStateCache();

//   const events = await fetchEventsInBlockRangeChunked(
//     fetchWorldEvents,
//     fromBlockNumber,
//     toBlockNumber,
//     interval,
//     setPercentage
//   );

//   storeEvents(stateCache, events);

//   return stateCache;
// }

export function groupByTxHash(events: NetworkComponentUpdate[]) {
  return events.reduce(
    (acc, event) => {
      if (['worker', 'cache'].includes(event.txHash)) return acc;

      if (!acc[event.txHash]) acc[event.txHash] = [];
      acc[event.txHash]!.push(event);

      return acc;
    },
    {} as { [key: string]: NetworkComponentUpdate[] }
  );
}
