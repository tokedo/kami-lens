/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/workers/types.ts
 * changes:  SyncWorkerConfig gains initialBlockNumber?: number and
 *           dataDir?: string. Upstream
 *           passes it at runtime (setupMUDNetwork startSync spreads it into
 *           the worker config) but the type omits it (vite-transpiled,
 *           never typechecked). The port's replay-floor hygiene fix in
 *           Worker.ts reads it, so the type now tells the truth. dataDir
 *           is the storage-backend injection the browser never needed
 *           (IndexedDB is ambient; the file-snapshot store is not —
 *           swap point 3). 0.6.0 adds reconcileIntervalMs (DESIGN §3.17,
 *           "L-1"): the period of the stream's periodic chain reconcile,
 *           configured by the daemon. Upstream has no such pass — a page
 *           reload is its reconcile. 0.6.2 takes stateCdnUrl from the
 *           forward-port below. Everything else verbatim.
 * forward-port: @ 21f419e63e0a7f6b642c255efeb89dd1c288de1c (sync-affecting
 *           bucket, ahead of the pin — SPEC §4.2): stateCdnUrl?: string.
 */

import { Components, ComponentValue, EntityID, SchemaOf } from 'engine/recs';
import { Interface, Result } from 'ethers';

import { ProviderConfig } from 'engine/providers';
import { Contracts } from 'engine/types';
import { TxMetadata } from 'engine/types/ecs-stream/ecs-stream';

export type ContractConfig = {
  address: string;
  abi: Interface;
};

export type ContractsConfig<C extends Contracts> = {
  [key in keyof C]: ContractConfig;
};

export type ContractEvent<C extends Contracts> = {
  contractKey: keyof C;
  eventKey: string;
  args: Result;
  txHash: string;
  lastEventInTx: boolean;
};

export type NetworkComponentUpdate<C extends Components = Components> = {
  [key in keyof C]: {
    type: NetworkEvents.NetworkComponentUpdate;
    component: key & string;
    value: ComponentValue<SchemaOf<C[key]>> | undefined;
  };
}[keyof C] & {
  entity: EntityID;
  lastEventInTx: boolean;
  txHash: string;
  txMetadata?: TxMetadata;
  blockNumber: number;
  /** 1.0.0 (A2(c)): the chain log's own index within its block. Present on
   * every event read from a stream frame or from a chain range (the frame's
   * (blockNumber, logIndex) IS the chain log's — measured 265/265,
   * 2026-10-03), and absent on events whose position is unknown: snapshot /
   * state-cache entries and Kamigaze diff events. The apply path orders by
   * (blockNumber, logIndex) and never lets an older write overwrite a newer
   * one. */
  logIndex?: number;
  /** 1.0.0 (A5): a statement the apply path acts on once this update (and
   * everything before it) has been applied. See AppliedMark. */
  appliedMark?: AppliedMark;
};

/** "Once this has been applied, every write of every block up to and
 * including `through` is in the mirror — PROVIDED the mirror already held
 * everything through `anchor`." (1.0.0, A5.)
 *
 * - the bootstrap fill: anchor null (unconditional), through = its end block;
 * - a continuity-checked stream frame in block F: anchor = the block the
 *   stream's unbroken chain of frames started from, through = F - 1 (frames
 *   are one per log, in order, so a frame in F means no log of any block
 *   below F is still to come);
 * - a proven chain range [from, c]: anchor = from - 1, through = c, and
 *   `reconciled` when it was the periodic reconcile (which also moves
 *   reconciledThrough). */
export type AppliedMark = {
  anchor: number | null;
  through: number;
  reconciled?: boolean;
};

/** txHash of a marker update that carries only an AppliedMark (no world
 * write). The daemon's stream-liveness tap ignores it. */
export const MARK_TXHASH = 'mark';

export type SystemCallTransaction = {
  hash: string;
  to: string;
  data: string;
  value: bigint;
};

export type SystemCall<C extends Components = Components> = {
  type: NetworkEvents.SystemCall;
  tx: SystemCallTransaction;
  updates: NetworkComponentUpdate<C>[];
};

export enum NetworkEvents {
  SystemCall = 'SystemCall',
  NetworkComponentUpdate = 'NetworkComponentUpdate',
}

export type NetworkEvent<C extends Components = Components> =
  | NetworkComponentUpdate<C>
  | SystemCall<C>;

export function isSystemCallEvent<C extends Components>(e: NetworkEvent<C>): e is SystemCall<C> {
  return e.type === NetworkEvents.SystemCall;
}

export function isNetworkComponentUpdateEvent<C extends Components>(
  e: NetworkEvent<C>
): e is NetworkComponentUpdate<C> {
  return e.type === NetworkEvents.NetworkComponentUpdate;
}

export type SyncWorkerConfig = {
  provider: ProviderConfig;
  worldContract: ContractConfig;
  disableCache?: boolean;
  chainId: number;
  snapshotServiceUrl?: string;
  streamServiceUrl?: string;
  initialBlockNumber?: number;
  dataDir?: string;
  fetchSystemCalls?: boolean;
  reconcileIntervalMs?: number;
  snapshotNumChunks?: number;
  stateCdnUrl?: string;
  pruneOptions?: { playerAddress: string; hashedComponentId: string };
};
