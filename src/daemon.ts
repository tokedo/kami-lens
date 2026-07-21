// kami-lens native module (not a port): the daemon assembly. This is the
// read-only counterpart of upstream setupMUDNetwork (which bundles the
// transaction executor and is therefore not ported): world + component
// registry + mappings + in-process SyncWorker + applyNetworkUpdates, plus
// the daemon-only responsibilities: loud-fail cold start (DESIGN §3.1),
// periodic checkpointing (DESIGN §3.5), bounded bootstrap retries (DESIGN
// §3.2), and status with tripwire counters (DESIGN §7).
//
// Checkpoint model (§3.5): a checkpoint is always a Kamigaze-consistent
// backfill artifact — the worker's own post-backfill save, refreshed on the
// configured interval by re-running the ported incremental snapshot fetch
// (GetStateBlock + deltas) and saving, exactly the browser's natural
// reload cycle translated to a daemon. Live stream events feed the recs
// mirror and status only; they are never folded into the persisted cache.
// (Folding them would mix daemon-local entity indexing into a file whose
// warm-restart heal — splice at the Kamigaze cursors and refetch — assumes
// Kamigaze indexing throughout; upstream avoids this by construction
// because the browser saves exactly once, before any live events.)

import { keccak256 } from '@mud-classic/utils';
import { Interface, JsonRpcProvider } from 'ethers';
import { Subject, Subscription } from 'rxjs';

import * as clock from 'clock';

import { abi as worldAbi } from 'abi/World.json';
import { VERSION as CACHE_VERSION } from 'cache/db';
import { GodID, SyncState, SyncStatus } from 'engine/constants';
import { createDecode } from 'engine/encoders';
import { createWorld, World } from 'engine/recs';
import { Components } from 'network/';
import { createComponents } from 'network/components';
import { applyNetworkUpdates } from 'network/setup';
import { log } from 'utils/logger';
import { createSyncWorker } from 'workers/create';
import { Ack, InputType } from 'workers/sync';
import { createSnapshotClient, fetchSnapshot } from 'workers/sync/snapshot';
import {
  getStateStore,
  loadStateCacheFromStore,
  saveStateCacheToStore,
} from 'workers/sync/state';
import { SyncWorkerConfig, isNetworkComponentUpdateEvent } from 'workers/types';

import { setupCacheInvalidationHandler } from 'network/systems/CacheInvalidationSystem';

import { KamiLensConfig, resolveConfig } from './config';
import { KamidenFeeds, KamidenStatus } from './kamiden';
import { Tripwires, tripwireReport } from './tripwires';

/** Documented error marker for refusing a cold start without a snapshot
 * source (DESIGN §3.1; asserted by gate G1.e). */
export const ERR_NO_SNAPSHOT_SOURCE = 'ERR_NO_SNAPSHOT_SOURCE';

/** Bounded bootstrap retry schedule (DESIGN §3.2). */
const BOOTSTRAP_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

const LOADING_STATE_COMPONENT_ID = keccak256('component.LoadingState');

export type CheckpointReport = {
  blockNumber: number;
  kamigazeNonce: number;
  stateEntries: number;
  numComponents: number;
  numEntities: number;
  at: string;
  durationMs: number;
};

export type DaemonStatus = {
  state: keyof typeof SyncState | 'STOPPED';
  msg: string;
  percentage: number;
  /** newest block seen on the live event stream */
  liveBlockNumber: number;
  /** ms since the last live stream event (0 before LIVE); > STREAM_STALL_MS
   * marks the daemon degraded (G3.e) */
  streamSilentMs: number;
  /** last Kamigaze-consistent checkpoint (null before first LIVE) */
  checkpoint: CheckpointReport | null;
  checkpointCount: number;
  tripwires: Tripwires;
  /** nonzero tripwires, rendered as 'name:count' — empty means healthy.
   * CHAIN health only: kamiden degradation lives in `kamiden` and never
   * stamps chain-row answers stale (§3.2 soft dependency). */
  degraded: string[];
  /** Kamiden feed health, per-feed (M4; DESIGN §3.2) */
  kamiden: KamidenStatus;
  bootstrapAttempts: number;
  startedAt: string;
  liveAt: string | null;
  config: {
    chainId: number;
    worldAddress: string;
    jsonRpcUrl: string;
    wsRpcUrl?: string;
    kamigazeUrl?: string;
    kamidenUrl?: string;
    chatEnabled: boolean;
    dataDir: string;
    checkpointIntervalMs: number;
  };
};

export class KamiLensDaemon {
  readonly config: KamiLensConfig;

  private syncStatus: SyncStatus = { state: SyncState.CONNECTING, msg: '', percentage: 0 };
  private worker: ReturnType<typeof createSyncWorker> | null = null;
  private world: ReturnType<typeof createWorld> | null = null;
  private components: ReturnType<typeof createComponents> | null = null;
  private subscriptions: Subscription[] = [];
  private feedCleanups: (() => void)[] = [];
  private checkpointTimer: NodeJS.Timeout | null = null;
  private clockSyncTimer: NodeJS.Timeout | null = null;
  private clockProvider: JsonRpcProvider | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private bootstrapAttempts = 0;
  private checkpointCount = 0;
  private lastCheckpoint: CheckpointReport | null = null;
  private checkpointInFlight = false;
  private liveBlockNumber = 0;
  private lastStreamEventAtWallMs = 0;
  /** Stream-health surfacing (gate G3.e): once LIVE, a stream silent for
   * longer than this marks the daemon degraded and its answers stale —
   * last-synced state keeps being served, honestly stamped. */
  static readonly STREAM_STALL_MS = 60_000;
  private readonly startedAt = new Date().toISOString();
  private liveAt: string | null = null;

  /** Emits on every sync-state transition and once after each checkpoint. */
  readonly status$ = new Subject<DaemonStatus>();
  /** Resolves when the daemon first reaches LIVE; rejects on terminal failure. */
  readonly live: Promise<void>;
  private resolveLive!: () => void;
  private rejectLive!: (e: Error) => void;

  /** Kamiden feed supervisor (M4): constructed with the daemon so the
   * client is configured before any consumer looks it up; started only on
   * LIVE, stopped with the daemon. Soft dependency — its failures never
   * touch chain sync (DESIGN §3.2). */
  readonly kamiden: KamidenFeeds;

  constructor(overrides: Partial<KamiLensConfig> = {}) {
    this.config = resolveConfig(overrides);
    this.kamiden = new KamidenFeeds({
      url: this.config.kamidenUrl,
      bufferCapacity: this.config.kamidenBufferCapacity,
    });
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

    const store = await getStateStore(chainId, worldAddress, CACHE_VERSION, this.config.dataDir);
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
    this.components = components;

    // Status tap: LoadingState transitions and the newest live block. State
    // events feed the recs mirror via applyNetworkUpdates below; they are
    // never folded into the persisted cache (see checkpoint model above).
    this.subscriptions.push(
      worker.ecsEvents$.subscribe((updates) => {
        for (const update of updates) {
          if (!isNetworkComponentUpdateEvent(update)) continue;
          if (update.txHash === 'worker') {
            if (update.component === LOADING_STATE_COMPONENT_ID && update.entity === GodID) {
              this.onSyncStatus(update.value as unknown as SyncStatus);
            }
            continue;
          }
          if (update.blockNumber > this.liveBlockNumber) this.liveBlockNumber = update.blockNumber;
          this.lastStreamEventAtWallMs = Date.now();
        }
      })
    );

    applyNetworkUpdates(world, components, worker.ecsEvents$, mappings, ack$);

    // Kamiden feed consumer (M4): stream casts/kills invalidate the
    // affected kami/bonus cache rows, exactly upstream's
    // CacheInvalidationSystem. Wired per-world (the closure holds this
    // bootstrap's world); torn down with the worker. Inert until the
    // supervisor starts dispatching feeds on LIVE.
    this.feedCleanups.push(
      setupCacheInvalidationHandler({
        world,
        components,
        network: { connectedAddress: { get: () => undefined } },
      })
    );

    const { chainId, worldAddress, jsonRpcUrl, wsRpcUrl, kamigazeUrl, initialBlockNumber, dataDir } =
      this.config;
    const syncWorkerConfig: SyncWorkerConfig = {
      provider: { chainId, jsonRpcUrl, wsRpcUrl, options: { batch: false } },
      worldContract: { address: worldAddress, abi: new Interface(worldAbi) },
      chainId,
      snapshotServiceUrl: kamigazeUrl,
      streamServiceUrl: kamigazeUrl,
      initialBlockNumber,
      dataDir,
      fetchSystemCalls: false,
    };
    worker.input$.next({ type: InputType.Config, data: syncWorkerConfig });
  }

  private onSyncStatus(status: SyncStatus): void {
    this.syncStatus = status;
    if (status.state === SyncState.LIVE && !this.liveAt) {
      this.liveAt = new Date().toISOString();
      this.bootstrapAttempts = 0;
      void this.onLive();
    }
    if (status.state === SyncState.FAILED) this.onFailed(status);
    this.status$.next(this.getStatus());
  }

  /** On first LIVE: adopt the worker's post-backfill save as checkpoint #1
   * and begin the periodic refresh cycle (DESIGN §3.5). */
  private async onLive(): Promise<void> {
    try {
      this.lastCheckpoint = await this.readCheckpointReport(0);
      this.checkpointCount = 1;
    } catch (e) {
      log.warn('[daemon] failed to read the post-backfill checkpoint', e);
    }
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    this.checkpointTimer = setInterval(() => {
      void this.checkpoint().catch((e) => log.error('[daemon] checkpoint failed', e));
    }, this.config.checkpointIntervalMs);
    this.checkpointTimer.unref?.();
    this.startClockSync();
    // Kamiden feeds start once the chain mirror is LIVE (soft dependency:
    // a feed failure degrades feed rows in status, never chain service).
    this.kamiden.start();
    this.resolveLive();
  }

  /** §3.8 clock observations. The Kamigaze stream's blockTimestamp field
   * arrives as 0 — the server never populates it (measured live 2026-07-21;
   * the stream tap in workers/sync/stream stays armed in case that changes,
   * and fresher observations would simply win). The operative source is
   * therefore the header timestamp of a block the stream HAS delivered,
   * fetched via RPC on a slow cadence. A very fresh block can be missing on
   * a lagging load-balanced backend (the G1.b lesson) — getBlock() then
   * returns null and the sync just waits for the next tick. */
  private static readonly CLOCK_SYNC_INTERVAL_MS = 300_000;

  private startClockSync(): void {
    if (this.clockSyncTimer) clearInterval(this.clockSyncTimer);
    void this.syncClock().catch((e) => log.warn('[daemon] clock sync failed', e));
    this.clockSyncTimer = setInterval(() => {
      void this.syncClock().catch((e) => log.warn('[daemon] clock sync failed', e));
    }, KamiLensDaemon.CLOCK_SYNC_INTERVAL_MS);
    this.clockSyncTimer.unref?.();
  }

  private async syncClock(): Promise<void> {
    if (this.stopped || !this.liveBlockNumber) return;
    const { chainId, jsonRpcUrl } = this.config;
    this.clockProvider ??= new JsonRpcProvider(
      jsonRpcUrl,
      { chainId, name: 'yominet' },
      { staticNetwork: true }
    );
    const block = await this.clockProvider.getBlock(this.liveBlockNumber);
    if (block) clock.observeBlockTimestamp(block.timestamp);
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

  /**
   * Refresh the persisted Kamigaze-consistent cache (DESIGN §3.5): load the
   * stored cache, run the ported incremental snapshot fetch (GetStateBlock
   * + deltas since the stored cursors; a nonce change forces the full
   * reload, exactly as at bootstrap), save, release. The browser's reload
   * cycle, minus the browser.
   */
  async checkpoint(): Promise<CheckpointReport> {
    if (!this.config.kamigazeUrl) {
      throw new Error('checkpoint refresh requires a Kamigaze URL (no-snapshot mode is bootstrap-only)');
    }
    if (this.checkpointInFlight) {
      log.warn('[daemon] checkpoint already in flight — skipping this interval');
      return this.lastCheckpoint!;
    }
    this.checkpointInFlight = true;
    const t0 = Date.now();
    try {
      const store = await getStateStore(
        this.config.chainId,
        this.config.worldAddress,
        CACHE_VERSION,
        this.config.dataDir
      );
      let cache = await loadStateCacheFromStore(store);
      const client = createSnapshotClient(this.config.kamigazeUrl);
      cache = await fetchSnapshot(
        cache,
        client,
        createDecode(),
        10,
        () => {},
        () => {}
      );
      await saveStateCacheToStore(store, cache);
      this.checkpointCount++;
      this.lastCheckpoint = {
        blockNumber: cache.blockNumber,
        kamigazeNonce: cache.kamigazeNonce,
        stateEntries: cache.state.size,
        numComponents: cache.components.length,
        numEntities: cache.entities.length,
        at: new Date().toISOString(),
        durationMs: Date.now() - t0,
      };
      this.status$.next(this.getStatus());
      return this.lastCheckpoint;
    } finally {
      this.checkpointInFlight = false;
    }
  }

  /** Summarize the currently stored cache without refreshing it. */
  private async readCheckpointReport(durationMs: number): Promise<CheckpointReport> {
    const store = await getStateStore(
      this.config.chainId,
      this.config.worldAddress,
      CACHE_VERSION,
      this.config.dataDir
    );
    const [blockNumber, nonce, state, components, entities] = await Promise.all([
      store.get('BlockNumber', 'current'),
      store.get('KamigazeNonce', 'current'),
      store.get('ComponentValues', 'current'),
      store.get('Mappings', 'components'),
      store.get('Mappings', 'entities'),
    ]);
    return {
      blockNumber: blockNumber ?? 0,
      kamigazeNonce: nonce ?? 0,
      stateEntries: state?.size ?? 0,
      numComponents: components?.length ?? 0,
      numEntities: entities?.length ?? 0,
      at: new Date().toISOString(),
      durationMs,
    };
  }

  /** The live recs mirror for the query surface (DESIGN §4.3); null before
   * the first bootstrap. Read-only by convention — queries never mutate. */
  getMirror(): { world: World; components: Components; blockNumber: number } | null {
    if (!this.world || !this.components) return null;
    return { world: this.world, components: this.components, blockNumber: this.liveBlockNumber };
  }

  getStatus(): DaemonStatus {
    const {
      chainId,
      worldAddress,
      jsonRpcUrl,
      wsRpcUrl,
      kamigazeUrl,
      kamidenUrl,
      chatEnabled,
      dataDir,
      checkpointIntervalMs,
    } = this.config;
    const tripwires = tripwireReport();
    const streamSilentMs =
      this.liveAt && this.lastStreamEventAtWallMs > 0
        ? Date.now() - this.lastStreamEventAtWallMs
        : 0;
    const streamStalled = !this.stopped && streamSilentMs > KamiLensDaemon.STREAM_STALL_MS;
    return {
      state: this.stopped ? 'STOPPED' : (SyncState[this.syncStatus.state] as keyof typeof SyncState),
      msg: this.syncStatus.msg,
      percentage: this.syncStatus.percentage,
      liveBlockNumber: this.liveBlockNumber,
      streamSilentMs,
      checkpoint: this.lastCheckpoint,
      checkpointCount: this.checkpointCount,
      tripwires,
      degraded: [
        ...(streamStalled ? [`stream-stalled:${Math.floor(streamSilentMs / 1000)}s`] : []),
        ...Object.entries(tripwires)
          .filter(([, count]) => count > 0)
          .map(([name, count]) => `${name}:${count}`),
      ],
      kamiden: this.kamiden.getStatus(),
      bootstrapAttempts: this.bootstrapAttempts,
      startedAt: this.startedAt,
      liveAt: this.liveAt,
      config: {
        chainId,
        worldAddress,
        jsonRpcUrl,
        wsRpcUrl,
        kamigazeUrl,
        kamidenUrl,
        chatEnabled,
        dataDir,
        checkpointIntervalMs,
      },
    };
  }

  private teardownWorker(): void {
    for (const sub of this.subscriptions) sub.unsubscribe();
    this.subscriptions = [];
    for (const cleanup of this.feedCleanups) cleanup();
    this.feedCleanups = [];
    this.worker?.dispose();
    this.worker = null;
    this.world?.dispose();
    this.world = null;
  }

  /** Clean shutdown: final checkpoint refresh (if LIVE was ever reached and
   * a snapshot source exists), then dispose (DESIGN §3.5). */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.kamiden.stop();
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    if (this.clockSyncTimer) clearInterval(this.clockSyncTimer);
    this.clockProvider?.destroy();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.liveAt && this.config.kamigazeUrl) {
      try {
        await this.checkpoint();
      } catch (e) {
        log.error('[daemon] final checkpoint failed — keeping the last saved snapshot', e);
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
