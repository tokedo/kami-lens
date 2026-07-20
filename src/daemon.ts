// kami-lens native module (not a port): the daemon assembly. This is the
// read-only counterpart of upstream setupMUDNetwork (which bundles the
// transaction executor and is therefore not ported): world + component
// registry + mappings + in-process SyncWorker + applyNetworkUpdates, plus
// the daemon-only responsibilities: loud-fail cold start (DESIGN §3.1),
// live mirror StateCache with periodic checkpointing (DESIGN §3.5), bounded
// bootstrap retries (DESIGN §3.2), and status with tripwire counters
// (DESIGN §7).

import { keccak256 } from '@mud-classic/utils';
import { Interface, JsonRpcProvider } from 'ethers';
import { Subject, Subscription } from 'rxjs';

import { abi as worldAbi } from 'abi/World.json';
import { VERSION as CACHE_VERSION } from 'cache/db';
import { GodID, SyncState, SyncStatus } from 'engine/constants';
import { createWorld } from 'engine/recs';
import { createComponents } from 'network/components';
import { applyNetworkUpdates } from 'network/setup';
import { log } from 'utils/logger';
import { createSyncWorker } from 'workers/create';
import { Ack, InputType } from 'workers/sync';
import {
  StateCache,
  createStateCache,
  getStateStore,
  saveStateCacheToStore,
  storeStateEvent,
} from 'workers/sync/state';
import { SyncWorkerConfig, isNetworkComponentUpdateEvent } from 'workers/types';

import { KamiLensConfig, resolveConfig } from './config';
import { Tripwires, tripwireReport } from './tripwires';

/** Documented error marker for refusing a cold start without a snapshot
 * source (DESIGN §3.1; asserted by gate G1.e). */
export const ERR_NO_SNAPSHOT_SOURCE = 'ERR_NO_SNAPSHOT_SOURCE';

/** Bounded bootstrap retry schedule (DESIGN §3.2). */
const BOOTSTRAP_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

const LOADING_STATE_COMPONENT_ID = keccak256('component.LoadingState');

export type DaemonStatus = {
  state: keyof typeof SyncState | 'STOPPED';
  msg: string;
  percentage: number;
  blockNumber: number;
  lastKamigazeBlock: number;
  kamigazeNonce: number;
  stateEntries: number;
  numComponents: number;
  numEntities: number;
  tripwires: Tripwires;
  bootstrapAttempts: number;
  checkpoints: { count: number; lastAt: string | null };
  startedAt: string;
  liveAt: string | null;
  config: {
    chainId: number;
    worldAddress: string;
    jsonRpcUrl: string;
    wsRpcUrl?: string;
    kamigazeUrl?: string;
    dataDir: string;
    checkpointIntervalMs: number;
  };
};

export class KamiLensDaemon {
  readonly config: KamiLensConfig;
  readonly mirror: StateCache = createStateCache();

  private syncStatus: SyncStatus = { state: SyncState.CONNECTING, msg: '', percentage: 0 };
  private worker: ReturnType<typeof createSyncWorker> | null = null;
  private world: ReturnType<typeof createWorld> | null = null;
  private subscriptions: Subscription[] = [];
  private checkpointTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private bootstrapAttempts = 0;
  private checkpointCount = 0;
  private lastCheckpointAt: string | null = null;
  private readonly startedAt = new Date().toISOString();
  private liveAt: string | null = null;

  /** Emits on every sync-state transition and once after each checkpoint. */
  readonly status$ = new Subject<DaemonStatus>();
  /** Resolves when the daemon first reaches LIVE; rejects on terminal failure. */
  readonly live: Promise<void>;
  private resolveLive!: () => void;
  private rejectLive!: (e: Error) => void;

  constructor(overrides: Partial<KamiLensConfig> = {}) {
    this.config = resolveConfig(overrides);
    this.live = new Promise<void>((resolve, reject) => {
      this.resolveLive = resolve;
      this.rejectLive = reject;
    });
    // gates and library callers may only await `live` on failure paths
    this.live.catch(() => {});
  }

  async start(): Promise<void> {
    await this.preflight();
    this.bootstrap();
  }

  /**
   * Loud-fail cold start (DESIGN §3.1): without a snapshot source, a fresh
   * mirror can only bootstrap from an RPC whose log history covers the
   * world's full span (dev chain or archive node). The public RPC prunes
   * silently (empty HTTP-200 results), so probe the world's initial blocks
   * and refuse — loudly — rather than sync a hollow world.
   */
  private async preflight(): Promise<void> {
    const { kamigazeUrl, chainId, worldAddress, initialBlockNumber, jsonRpcUrl } = this.config;
    if (kamigazeUrl) return;

    const store = await getStateStore(chainId, worldAddress, CACHE_VERSION);
    const cachedBlock = (await store.get('BlockNumber', 'current')) ?? 0;
    if (cachedBlock > 0) {
      log.warn(
        '[daemon] no snapshot source configured; resuming from cached state at block',
        cachedBlock,
        '— RPC gap-fill only heals within the log-retention window'
      );
      return;
    }

    const provider = new JsonRpcProvider(jsonRpcUrl, { chainId, name: 'yominet' }, { staticNetwork: true });
    try {
      const iface = new Interface(worldAbi);
      const topics = [
        [
          iface.getEvent('ComponentValueSet')!.topicHash,
          iface.getEvent('ComponentValueRemoved')!.topicHash,
        ],
      ];
      const probeSpan = 5_000;
      const logs = await provider.getLogs({
        address: worldAddress,
        fromBlock: initialBlockNumber,
        toBlock: initialBlockNumber + probeSpan,
        topics,
      });
      if (logs.length === 0) {
        const error = new Error(
          `${ERR_NO_SNAPSHOT_SOURCE}: no snapshot service configured, no cached state, and the ` +
            `RPC returned no World logs in the deploy range ` +
            `[${initialBlockNumber}, ${initialBlockNumber + probeSpan}] — its log history does ` +
            `not cover the world's span (pruned ranges return empty results, not errors). ` +
            `Refusing to bootstrap a hollow world. Configure a Kamigaze URL or point at an ` +
            `archive/dev RPC.`
        );
        (error as Error & { code: string }).code = ERR_NO_SNAPSHOT_SOURCE;
        this.rejectLive(error);
        throw error;
      }
      log.info(
        `[daemon] no snapshot source, but the RPC serves the world's deploy range ` +
          `(${logs.length} logs) — proceeding with RPC bootstrap`
      );
    } finally {
      provider.destroy();
    }
  }

  private bootstrap(): void {
    if (this.stopped) return;
    this.bootstrapAttempts++;

    const world = createWorld();
    const components = createComponents(world);

    // Mapping from hashed contract component id to client component key
    // (as setupMUDNetwork builds it; the registry already includes the
    // Components/Systems registries and LoadingState).
    const mappings: { [hashedId: string]: string } = {};
    for (const [key, component] of Object.entries(components)) {
      const contractId = component.metadata?.contractId as string | undefined;
      if (!contractId) continue;
      mappings[keccak256(contractId)] = key;
    }

    const ack$ = new Subject<Ack>();
    const worker = createSyncWorker(ack$);
    this.worker = worker;
    this.world = world;

    // Daemon-side live mirror: replay every real state event the worker
    // emits (initial cache dump + gap fill + live stream) into a StateCache
    // via the same ported storeStateEvent path the worker itself uses.
    // Pseudo-events are excluded: txHash 'worker' (LoadingState) and the
    // EmptyNetworkEvent keepalive.
    this.subscriptions.push(
      worker.ecsEvents$.subscribe((updates) => {
        for (const update of updates) {
          if (!isNetworkComponentUpdateEvent(update)) continue;
          if (update.txHash === 'worker') {
            if (update.component === LOADING_STATE_COMPONENT_ID) {
              this.onSyncStatus(update.value as unknown as SyncStatus, update.entity === GodID);
            }
            continue;
          }
          if (update.txHash === 'EmptyNetworkEvent') continue;
          storeStateEvent(this.mirror, update);
        }
      })
    );

    applyNetworkUpdates(world, components, worker.ecsEvents$, mappings, ack$);

    const { chainId, worldAddress, jsonRpcUrl, wsRpcUrl, kamigazeUrl, initialBlockNumber } =
      this.config;
    const syncWorkerConfig: SyncWorkerConfig = {
      provider: { chainId, jsonRpcUrl, wsRpcUrl, options: { batch: false } },
      worldContract: { address: worldAddress, abi: new Interface(worldAbi) },
      chainId,
      snapshotServiceUrl: kamigazeUrl,
      streamServiceUrl: kamigazeUrl,
      initialBlockNumber,
      fetchSystemCalls: false,
    };
    worker.input$.next({ type: InputType.Config, data: syncWorkerConfig });
  }

  private onSyncStatus(status: SyncStatus, _isGod: boolean): void {
    this.syncStatus = status;
    if (status.state === SyncState.LIVE && !this.liveAt) {
      this.liveAt = new Date().toISOString();
      this.bootstrapAttempts = 0;
      void this.onLive();
    }
    if (status.state === SyncState.FAILED) this.onFailed(status);
    this.status$.next(this.getStatus());
  }

  /** On first LIVE: adopt the Kamigaze cursors the worker persisted at
   * backfill time, then begin periodic checkpointing (DESIGN §3.5). */
  private async onLive(): Promise<void> {
    try {
      const store = await getStateStore(
        this.config.chainId,
        this.config.worldAddress,
        CACHE_VERSION
      );
      this.mirror.lastKamigazeBlock = (await store.get('LastKamigazeBlock', 'current')) ?? 0;
      this.mirror.lastKamigazeEntity = (await store.get('LastKamigazeEntity', 'current')) ?? 0;
      this.mirror.lastKamigazeComponent = (await store.get('LastKamigazeComponent', 'current')) ?? 0;
      this.mirror.kamigazeNonce = (await store.get('KamigazeNonce', 'current')) ?? 0;
    } catch (e) {
      log.warn('[daemon] failed to adopt Kamigaze cursors from the snapshot store', e);
    }
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    this.checkpointTimer = setInterval(() => {
      void this.checkpoint().catch((e) => log.error('[daemon] checkpoint failed', e));
    }, this.config.checkpointIntervalMs);
    this.checkpointTimer.unref?.();
    this.resolveLive();
  }

  /** Bounded bootstrap retry (DESIGN §3.2): upstream shows the player an
   * error and the player reloads; the daemon retries on a fixed schedule
   * and gives up loudly when the schedule is exhausted. Only pre-LIVE
   * failures land here — post-LIVE stream outages are handled by the
   * ported stream retry loop. */
  private onFailed(status: SyncStatus): void {
    if (this.stopped || this.liveAt) return;
    // the worker retries INITIALIZE errors internally; only act when it has
    // given up (rate limit / save failure / max retries — all terminal)
    if (status.msg.includes('retrying in')) return;

    this.teardownWorker();
    if (this.bootstrapAttempts > BOOTSTRAP_RETRY_DELAYS_MS.length) {
      const error = new Error(
        `bootstrap failed after ${this.bootstrapAttempts} attempts: ${status.msg}`
      );
      log.error('[daemon]', error.message);
      this.rejectLive(error);
      return;
    }
    const delay = BOOTSTRAP_RETRY_DELAYS_MS[this.bootstrapAttempts - 1]!;
    log.warn(
      `[daemon] bootstrap attempt ${this.bootstrapAttempts} failed (${status.msg}); ` +
        `retrying in ${delay / 1000}s`
    );
    this.retryTimer = setTimeout(() => this.bootstrap(), delay);
    this.retryTimer.unref?.();
  }

  /** Persist the live mirror wholesale (DESIGN §3.5). */
  async checkpoint(): Promise<void> {
    const store = await getStateStore(this.config.chainId, this.config.worldAddress, CACHE_VERSION);
    await saveStateCacheToStore(store, this.mirror);
    this.checkpointCount++;
    this.lastCheckpointAt = new Date().toISOString();
    this.status$.next(this.getStatus());
  }

  getStatus(): DaemonStatus {
    const { chainId, worldAddress, jsonRpcUrl, wsRpcUrl, kamigazeUrl, dataDir, checkpointIntervalMs } =
      this.config;
    return {
      state: this.stopped ? 'STOPPED' : (SyncState[this.syncStatus.state] as keyof typeof SyncState),
      msg: this.syncStatus.msg,
      percentage: this.syncStatus.percentage,
      blockNumber: this.mirror.blockNumber,
      lastKamigazeBlock: this.mirror.lastKamigazeBlock,
      kamigazeNonce: this.mirror.kamigazeNonce,
      stateEntries: this.mirror.state.size,
      numComponents: this.mirror.components.length,
      numEntities: this.mirror.entities.length,
      tripwires: tripwireReport(),
      bootstrapAttempts: this.bootstrapAttempts,
      checkpoints: { count: this.checkpointCount, lastAt: this.lastCheckpointAt },
      startedAt: this.startedAt,
      liveAt: this.liveAt,
      config: { chainId, worldAddress, jsonRpcUrl, wsRpcUrl, kamigazeUrl, dataDir, checkpointIntervalMs },
    };
  }

  private teardownWorker(): void {
    for (const sub of this.subscriptions) sub.unsubscribe();
    this.subscriptions = [];
    this.worker?.dispose();
    this.worker = null;
    this.world?.dispose();
    this.world = null;
  }

  /** Clean shutdown: final checkpoint (if LIVE was ever reached), then
   * dispose (DESIGN §3.5). */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.liveAt) {
      try {
        await this.checkpoint();
      } catch (e) {
        log.error('[daemon] final checkpoint failed', e);
      }
    }
    this.teardownWorker();
    this.status$.next(this.getStatus());
    this.status$.complete();
  }
}

/** Convenience: construct, start, and return the daemon. */
export async function startDaemon(overrides: Partial<KamiLensConfig> = {}): Promise<KamiLensDaemon> {
  const daemon = new KamiLensDaemon(overrides);
  await daemon.start();
  return daemon;
}
