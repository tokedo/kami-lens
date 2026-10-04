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
//
// AND SINCE 0.6.3 THAT IS WHY IT RUNS SOMEWHERE ELSE (divergence 16). The
// refresh never touches the live mirror, so the whole of it — deserialize
// the stored cache, delta, serialize, commit — happens in a child process
// (workers/checkpoint/) and the main thread gets a small report. Measured
// reason: the synchronous v8.serialize of ~230 MB left the daemon unable to
// answer `status` for 20-32 s every ten minutes on the VM, which is both a
// broken promise (DESIGN/server.ts: `status` is the one query that must
// always answer) and the trigger for a watchdog restart that lands mid-write
// — the killed-mid-checkpoint class, manufactured by the health check itself.

import { keccak256 } from '@mud-classic/utils';
import { Interface, JsonRpcProvider } from 'ethers';
import { Subject, Subscription } from 'rxjs';

import * as clock from 'clock';

import { abi as worldAbi } from 'abi/World.json';
import { VERSION as CACHE_VERSION } from 'cache/db';
import { GodID, SyncState, SyncStatus } from 'engine/constants';
import { createWorld, World } from 'engine/recs';
import { Components } from 'network/';
import { createComponents } from 'network/components';
import { applyNetworkUpdates } from 'network/setup';
import { log } from 'utils/logger';
import { createSyncWorker } from 'workers/create';
import { Ack, InputType } from 'workers/sync';
import { getStateStore } from 'workers/sync/state';
import { MARK_TXHASH, SyncWorkerConfig, isNetworkComponentUpdateEvent } from 'workers/types';
import { CheckpointHost } from 'workers/checkpoint/host';

import { setupCacheInvalidationHandler } from 'network/systems/CacheInvalidationSystem';
import { clearConfigCaches, watchConfigWrites } from 'app/cache/config/base';
import { KamiCache } from 'app/cache/kami/base';

import { ConfigSource, KamiLensConfig, resolveConfigDetailed } from './config';
import type { NativeBalanceReader } from './queries/build';
import { KamidenFeeds, KamidenStatus } from './kamiden';
import {
  type FullLoadRecord,
  fullLoadReport,
  onAppliedAdvance,
  type SyncHealth,
  syncHealth,
  syncHealthReport,
  syncHooks,
  unhealedForMs,
} from './sync-health';
import { QueryError } from './queries/build';
import { Tripwires, absorbTripwires, tripwireReport } from './tripwires';
import { heapLimitMb, heapSource, type HeapSource } from './heap';
import { incompleteRowsReport, type IncompleteRows } from './projection-health';
import {
  bootstrapDelayMs,
  clearBootstrapBackoff,
  isResourceExhausted,
  readBootstrapBackoff,
  writeBootstrapBackoff,
} from './backoff';

/** Documented error marker for refusing a cold start without a snapshot
 * source (DESIGN §3.1; asserted by gate G1.e). */
export const ERR_NO_SNAPSHOT_SOURCE = 'ERR_NO_SNAPSHOT_SOURCE';

/** Bounded bootstrap retries per PROCESS (DESIGN §3.2): after this many
 * failed attempts the daemon gives up loudly (exit 1). 1.0.0 (A6): the delay
 * before each retry is exponential WITH JITTER (src/backoff.ts: 5 s doubling
 * to a 10-minute cap, drawn from [d/2, d]), a rate-limited failure counts
 * double, and the failure count is PERSISTED in the data directory — so a
 * supervisor that restarts the daemon after it gave up does not start the
 * ladder again at 5 s. Until 1.0.0 it was a fixed 5/15/30/60/120 s ladder
 * that every restart reset. */
const BOOTSTRAP_MAX_ATTEMPTS = 5;

/** Pre-LIVE progress bound (0.5.2, DESIGN §3.2). The bootstrap path is a
 * chain of awaits, and BEFORE 0.5.2 not one of them had a timeout of its
 * own: a socket that never opened held the whole sequence open with no
 * failure event, so the schedule above — which only ever sees the worker's
 * terminal errors — never engaged. Observed live 2026-08-27 (laptop-wake
 * restart): SETUP / "Starting State Sync" / 0% / liveBlockNumber 0 for 8+
 * minutes while the network was demonstrably back and `headBlockNumber` kept
 * advancing. The specific hole is fixed at its source (engine/providers
 * NETWORK_CHECK_TIMEOUT_MS); THIS is the bound that does not depend on
 * having found the right await. Ninety seconds is chosen against the
 * phases: every pre-LIVE phase either ticks a percentage or changes its
 * message far faster than this, and the one phase that legitimately goes
 * quiet — saving the state cache — was measured at 3.7 s for 2.96M entries.
 * A restart costs one bootstrap attempt out of the schedule above. */
const PRELIVE_STALL_MS = 90_000;

/** How often the pre-LIVE watchdog compares progress. Short relative to the
 * bound, so the restart fires close to it rather than up to a tick late. */
const PRELIVE_CHECK_INTERVAL_MS = 5_000;

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
  /** 'warm' = incremental resume from a cached snapshot, 'cold' = full
   * bootstrap, 'unknown' before the cache probe (G5.b asserts this) */
  bootstrapMode: 'warm' | 'cold' | 'unknown';
  /** cached block the warm resume started from (0 when cold) */
  resumeFromBlock: number;
  /** last Kamigaze-consistent checkpoint (null before first LIVE), plus
   * whether one is being written right now (0.6.3) */
  checkpoint: (CheckpointReport & { inFlight: boolean }) | null;
  checkpointCount: number;
  tripwires: Tripwires;
  /** nonzero tripwires, rendered as 'name:count' — empty means healthy.
   * CHAIN health only: kamiden degradation lives in `kamiden` and never
   * stamps chain-row answers stale (§3.2 soft dependency). */
  degraded: string[];
  /** Kamiden feed health, per-feed (M4; DESIGN §3.2) */
  kamiden: KamidenStatus;
  /** §3.13 (0.5.0): health of the ONE chain read the query layer makes (the
   * account gas balance). Reported here for exactly the reason the per-feed
   * Kamiden block is: the answer that needed it simply OMITS the block, so a
   * reader must be able to tell "this account holds nothing" from "the read
   * did not happen". */
  rpcReads: { ok: number; failed: number; lastError?: string };
  /** §3.17 (0.6.0): the sync layer's own recovery health. Counters since
   * process start. Deliberately NOT tripwires — reconnects are nonzero
   * within a minute of every healthy start, and a tripwire marks the daemon
   * degraded. The ONE condition here that is a real chain-correctness fault
   * (an unhealed range that has outlived two reconcile intervals) does reach
   * `degraded`, as `unhealed-ranges:<N>`. */
  sync: SyncHealth & { reconcileIntervalMs: number };
  /** 1.0.0 (A1): kamis the projection could not complete — refused on a
   * single-entity read, flagged on a list read. A counter, not a tripwire:
   * it never reaches `degraded` (see projection-health.ts). */
  incompleteRows: IncompleteRows;
  /** §3.1 (0.6.2): which source served this process's full state load, and
   * how long it took. null on a WARM boot, which ran no full load at all —
   * that is not a fault, and is why the field is null rather than absent. */
  lastFullLoad: FullLoadRecord | null;
  /** §3.1 (0.6.3): the JS heap cap this process is actually running under,
   * and who chose it. A cold boot needs ~4.2-4.4 GB and Node's own default
   * is well below that on most machines (2,096 MiB in a container, 4,144 on
   * a 64 GB Mac), so the daemon self-sizes or refuses — and this is where a
   * reader sees which happened without reading the boot log. */
  heap: { limitMb: number; source: HeapSource };
  bootstrapAttempts: number;
  startedAt: string;
  liveAt: string | null;
  config: {
    chainId: number;
    worldAddress: string;
    jsonRpcUrl: string;
    wsRpcUrl?: string;
    kamigazeUrl?: string;
    stateCdnUrl?: string;
    kamidenUrl?: string;
    chatEnabled: boolean;
    enrich: boolean;
    dataDir: string;
    checkpointIntervalMs: number;
    reconcileIntervalMs: number;
  };
};

export class KamiLensDaemon {
  readonly config: KamiLensConfig;
  /** which precedence level produced each config key (DESIGN §5; G5.c) */
  readonly configSources: Record<keyof KamiLensConfig, ConfigSource>;
  /** the config file that was read, if any */
  readonly configFile: string | null;

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
  /** pre-LIVE progress watchdog (§3.2): the timer, and the last distinct
   * progress observation it saw. The KEY is compared, not any single field —
   * a message change is progress just as a percentage tick is, and the
   * "Saving State Cache" phase ticks neither percentage nor block. */
  private preLiveTimer: NodeJS.Timeout | null = null;
  private preLiveProgressKey = '';
  private preLiveProgressAtWallMs = 0;
  private stopped = false;
  private bootstrapAttempts = 0;
  private checkpointCount = 0;
  private lastCheckpoint: CheckpointReport | null = null;
  private checkpointInFlight = false;
  /** the off-thread checkpoint runner (§3.5, divergence 16) */
  private readonly checkpointHost = new CheckpointHost();
  private liveBlockNumber = 0;
  private lastStreamEventAtWallMs = 0;
  private bootstrapMode: 'warm' | 'cold' | 'unknown' = 'unknown';
  private resumeFromBlock = 0;
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

  /** §3.13: native-balance reads for the query layer. Lazily builds one
   * provider against the configured RPC and counts its outcomes so `status`
   * can report them. A rejection reaches `accountQuery` as "no gas block":
   * the mirror answer is never blocked on the chain. */
  readonly rpc: NativeBalanceReader;

  private rpcProvider: JsonRpcProvider | null = null;

  /** 1.0.0 (A7): the chain head, sampled in the BACKGROUND every
   * HEAD_SAMPLE_INTERVAL_MS — `status` reads this and does no network I/O
   * on its request path. Undefined until the first sample lands. */
  headSample: { blockNumber: number; sampledAt: string; sampledAtWallMs: number } | undefined;
  private headTimer: NodeJS.Timeout | null = null;
  static readonly HEAD_SAMPLE_INTERVAL_MS = 10_000;
  static readonly HEAD_SAMPLE_TIMEOUT_MS = 5_000;
  /** a sample older than this is not served (the three head fields are
   * absent together, as they always were on a failed read) */
  static readonly HEAD_SAMPLE_MAX_AGE_MS = 60_000;

  private async sampleHeadNow(): Promise<void> {
    try {
      const blockNumber = await Promise.race([
        this.rpc.blockNumber(),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), KamiLensDaemon.HEAD_SAMPLE_TIMEOUT_MS).unref?.()
        ),
      ]);
      if (blockNumber === undefined || !Number.isFinite(blockNumber)) return;
      const now = Date.now();
      this.headSample = {
        blockNumber,
        sampledAt: new Date(clock.now()).toISOString(),
        sampledAtWallMs: now,
      };
    } catch {
      /* counted in rpcReads by the reader itself */
    }
  }

  private startHeadSampler(): void {
    if (this.headTimer) return;
    void this.sampleHeadNow();
    this.headTimer = setInterval(() => void this.sampleHeadNow(), KamiLensDaemon.HEAD_SAMPLE_INTERVAL_MS);
    this.headTimer.unref?.();
  }

  /** The head sample `status` serves: the latest one, if it is fresh. */
  currentHeadSample(): { blockNumber: number; sampledAt: string } | undefined {
    const h = this.headSample;
    if (!h || Date.now() - h.sampledAtWallMs > KamiLensDaemon.HEAD_SAMPLE_MAX_AGE_MS) return undefined;
    return { blockNumber: h.blockNumber, sampledAt: h.sampledAt };
  }
  private rpcOk = 0;
  private rpcFailed = 0;
  private rpcLastError: string | null = null;

  private nativeProvider(): JsonRpcProvider {
    if (!this.rpcProvider) {
      const { chainId, jsonRpcUrl } = this.config;
      this.rpcProvider = new JsonRpcProvider(
        jsonRpcUrl,
        { chainId, name: 'yominet' },
        { staticNetwork: true }
      );
    }
    return this.rpcProvider;
  }

  private async rpcCall<T>(fn: (p: JsonRpcProvider) => Promise<T>): Promise<T> {
    try {
      const out = await fn(this.nativeProvider());
      this.rpcOk += 1;
      return out;
    } catch (e) {
      this.rpcFailed += 1;
      this.rpcLastError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  constructor(
    overrides: Partial<KamiLensConfig> = {},
    /** CLI flag layer — between overrides and env in precedence (§5) */
    flags: Partial<KamiLensConfig> & { configFile?: string } = {}
  ) {
    const resolved = resolveConfigDetailed(overrides, flags);
    this.config = resolved.config;
    this.configSources = resolved.sources;
    this.configFile = resolved.configFile;
    this.kamiden = new KamidenFeeds({
      url: this.config.kamidenUrl,
      bufferCapacity: this.config.kamidenBufferCapacity,
    });
    this.rpc = {
      blockNumber: () => this.rpcCall((p) => p.getBlockNumber()),
      nativeBalance: (address, blockTag) =>
        this.rpcCall(async (p) => p.getBalance(address, blockTag)),
    };
    this.live = new Promise<void>((resolve, reject) => {
      this.resolveLive = resolve;
      this.rejectLive = reject;
    });
    // gates and library callers may only await `live` on failure paths
    this.live.catch(() => {});
  }

  async start(): Promise<void> {
    await this.preflight();
    this.startHeadSampler();
    // warm/cold marker (G5.b): a cached block means the worker resumes
    // incrementally from the snapshot; zero means a full bootstrap
    try {
      const store = await getStateStore(
        this.config.chainId,
        this.config.worldAddress,
        CACHE_VERSION,
        this.config.dataDir
      );
      this.resumeFromBlock = (await store.get('BlockNumber', 'current')) ?? 0;
      this.bootstrapMode = this.resumeFromBlock > 0 ? 'warm' : 'cold';
    } catch {
      this.bootstrapMode = 'cold';
    }
    // 1.0.0 (A6): a daemon restarted in the middle of a failure streak keeps
    // backing off where the last process left off
    const persisted = await readBootstrapBackoff(this.config.dataDir);
    if (persisted) {
      this.persistedFailures = persisted.failures;
      const delay = bootstrapDelayMs(persisted.failures);
      log.warn(
        `[daemon] ${persisted.failures} consecutive bootstrap failure(s) on record ` +
          `(last ${persisted.lastFailureAt}); first attempt in ${(delay / 1000).toFixed(1)}s`
      );
      this.retryTimer = setTimeout(() => this.bootstrap(), delay);
      this.retryTimer.unref?.();
      return;
    }
    this.bootstrap();
  }

  /** failures carried over from earlier processes (1.0.0, A6) */
  private persistedFailures = 0;
  /** failures this process counts toward the backoff, rate limits double */
  private backoffFailures = 0;

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
    this.armPreLiveWatchdog();

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

    // 1.0.0 (A5): a new world starts with nothing applied and nothing
    // verified; its bootstrap fill and its reconcile seed set both again
    syncHealth.appliedThrough = null;
    syncHealth.reconciledThrough = null;

    const ack$ = new Subject<Ack>();
    const worker = createSyncWorker(ack$);
    this.worker = worker;
    this.world = world;
    this.components = components;

    // Status tap: LoadingState transitions and the newest live block. State
    // events feed the recs mirror via applyNetworkUpdates below; they are
    // never folded into the persisted cache (see checkpoint model above).
    //
    // One call per WORKER BATCH, not per event: the worker buffers its
    // output by time (workers/sync/Worker.ts work(): bufferTime 33 ms, at
    // most 33,333 events) and hands each buffer over as one array, waiting
    // for the apply side's ack before the next. A stream frame's events —
    // a gap heal's range, oldest block first, and then the frame's own — are
    // emitted synchronously in one go, so they arrive in ONE batch.
    this.subscriptions.push(
      worker.ecsEvents$.subscribe((updates) => {
        let sampleClock = false;
        for (const update of updates) {
          if (!isNetworkComponentUpdateEvent(update)) continue;
          if (update.txHash === 'worker') {
            if (update.component === LOADING_STATE_COMPONENT_ID && update.entity === GodID) {
              this.onSyncStatus(update.value as unknown as SyncStatus);
            }
            continue;
          }
          // 1.0.0 (A5): a marker carries no world write and says nothing
          // about whether the stream is alive
          if (update.txHash === MARK_TXHASH) continue;
          // 1.0.2: does this event deliver a block NEWER than any delivered
          // so far? A reconcile pass's re-read writes, a gap heal's or a
          // catch-up's writes of blocks at or below that one do not — they
          // say nothing about "now".
          const advanced = update.blockNumber > this.liveBlockNumber;
          if (advanced) this.liveBlockNumber = update.blockNumber;
          // 1.0.0 (A1): the first event after a stall re-anchors the clock
          // rather than waiting for the next 300 s tick. 1.0.2: by ARMING the
          // sample like LIVE and the tick do — that first event can be a
          // reconcile write or the head of a gap heal that starts AT the
          // frozen block, and sampling there pinned now() to the frozen
          // block's time, by the whole stall
          const wasStalled =
            this.liveAt !== null &&
            this.lastStreamEventAtWallMs > 0 &&
            Date.now() - this.lastStreamEventAtWallMs > KamiLensDaemon.STREAM_STALL_MS;
          this.lastStreamEventAtWallMs = Date.now();
          if (wasStalled) {
            this.clockAwaitingLiveSample = true;
            this.clockFollowUpOwed = true; // B2: its first sample gets one follow-up
          }
          // 1.0.0 (A1) after LIVE; 1.0.2 after every clock tick and every
          // stall: an ARMED sample is taken by an event that delivers a newer
          // block than any delivered so far (and than the last sample) — never
          // by the timer (see startClockSync)
          if (
            this.clockAwaitingLiveSample &&
            advanced &&
            update.blockNumber > this.lastClockSampleBlock
          ) {
            this.clockAwaitingLiveSample = false;
            sampleClock = true;
          }
        }
        // 1.0.2: the read runs once the whole batch is in, so syncClock (which
        // reads liveBlockNumber when it runs) samples the NEWEST block this
        // batch delivered, not the first one that advanced
        if (sampleClock) {
          void this.syncClock().catch((e) => log.warn('[daemon] clock sync failed', e));
        }
      })
    );

    applyNetworkUpdates(world, components, worker.ecsEvents$, mappings, ack$);

    // 1.0.0 (B4): a config write drops the cached config fields it touched,
    // and the kami cache built from them. A new world restarts entity
    // indices, so the config bookkeeping is emptied before it is rebuilt.
    clearConfigCaches();
    this.subscriptions.push(watchConfigWrites(components, () => KamiCache.clear()));

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

    const {
      chainId,
      worldAddress,
      jsonRpcUrl,
      wsRpcUrl,
      kamigazeUrl,
      stateCdnUrl,
      initialBlockNumber,
      dataDir,
      reconcileIntervalMs,
    } = this.config;
    const syncWorkerConfig: SyncWorkerConfig = {
      provider: { chainId, jsonRpcUrl, wsRpcUrl, options: { batch: false } },
      worldContract: { address: worldAddress, abi: new Interface(worldAbi) },
      chainId,
      snapshotServiceUrl: kamigazeUrl,
      streamServiceUrl: kamigazeUrl,
      // §3.1 (0.6.2): set = a cold boot streams the full image from the state
      // CDN and bridges forward; unset = today's gRPC cold start unchanged.
      stateCdnUrl,
      initialBlockNumber,
      dataDir,
      fetchSystemCalls: false,
      reconcileIntervalMs,
    };
    worker.input$.next({ type: InputType.Config, data: syncWorkerConfig });
  }

  /** The progress fingerprint the watchdog compares. Any change is progress. */
  private progressKey(): string {
    return `${this.syncStatus.state}|${this.syncStatus.percentage}|${this.syncStatus.msg}|${this.liveBlockNumber}`;
  }

  /** Milliseconds since the last observed pre-LIVE progress; 0 once LIVE (or
   * before the watchdog has armed), so no caller can read a stall into a
   * healthy daemon. */
  private preLiveStalledForMs(): number {
    if (this.liveAt || this.stopped || this.preLiveProgressAtWallMs === 0) return 0;
    return Date.now() - this.preLiveProgressAtWallMs;
  }

  private armPreLiveWatchdog(): void {
    if (this.preLiveTimer) clearInterval(this.preLiveTimer);
    this.preLiveProgressKey = this.progressKey();
    this.preLiveProgressAtWallMs = Date.now();
    this.preLiveTimer = setInterval(() => this.checkPreLiveProgress(), PRELIVE_CHECK_INTERVAL_MS);
    this.preLiveTimer.unref?.();
  }

  private disarmPreLiveWatchdog(): void {
    if (this.preLiveTimer) clearInterval(this.preLiveTimer);
    this.preLiveTimer = null;
    this.preLiveProgressAtWallMs = 0;
  }

  /** One watchdog tick. A stalled pre-LIVE daemon is torn down and
   * re-bootstrapped through the SAME schedule a worker failure takes — it
   * counts as an attempt, and exhausting the schedule still rejects loudly
   * (§3.2). Routed through onFailed rather than around it so there is one
   * retry path, not two. */
  private checkPreLiveProgress(): void {
    if (this.stopped || this.liveAt) {
      this.disarmPreLiveWatchdog();
      return;
    }
    const key = this.progressKey();
    if (key !== this.preLiveProgressKey) {
      this.preLiveProgressKey = key;
      this.preLiveProgressAtWallMs = Date.now();
      return;
    }
    const stalledMs = this.preLiveStalledForMs();
    if (stalledMs < PRELIVE_STALL_MS) return;
    const seconds = Math.floor(stalledMs / 1000);
    log.warn(
      `[daemon] pre-LIVE stall: no progress for ${seconds}s — restarting bootstrap`
    );
    // re-arm BEFORE the restart so the next window is measured from now and a
    // teardown that itself takes time cannot trip the watchdog again
    this.preLiveProgressAtWallMs = Date.now();
    // SANITIZE THE EMBEDDED MESSAGE. onFailed stands down when it sees
    // 'retrying in', which is how the worker says "I am handling this
    // myself" — and the worker's own retry message is exactly the text this
    // line quotes. Left alone, a stall that happened WHILE the worker was
    // self-retrying would be swallowed by the marker it accidentally
    // repeated.
    const context = (this.syncStatus.msg || 'no message').split('retrying in').join('retrying after');
    this.onFailed({
      state: SyncState.FAILED,
      msg: `pre-LIVE stall: no progress for ${seconds}s (${context})`,
      percentage: this.syncStatus.percentage,
    });
  }

  private onSyncStatus(status: SyncStatus): void {
    this.syncStatus = status;
    if (status.state === SyncState.LIVE && !this.liveAt) {
      this.liveAt = new Date().toISOString();
      this.bootstrapAttempts = 0;
      this.persistedFailures = 0;
      this.backoffFailures = 0;
      void clearBootstrapBackoff(this.config.dataDir);
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
    this.disarmPreLiveWatchdog();
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
   * fetched via RPC. This is the cadence at which a sample is ARMED (1.0.2);
   * the sample itself is taken when the stream next delivers a block newer
   * than any delivered so far. A very fresh block can be missing on a lagging
   * load-balanced backend (the G1.b lesson) — getBlock() then returns null,
   * the sample stays armed and the next newer block is tried. */
  private static readonly CLOCK_SYNC_INTERVAL_MS = 300_000;

  /** 1.0.2 (B2): how long after the first sample following LIVE or a stall
   * ONE more sample is armed. That first sample is taken on the first block
   * the stream delivers then, and the stream replays its backlog first, so
   * the block can itself be old (−7.0 s measured on the clock-only
   * candidate) — and it then stood for 300 s. Thirty seconds is long enough
   * for a backlog to have drained and short against the cadence. */
  static readonly CLOCK_FOLLOW_UP_MS = 30_000;

  private startClockSync(): void {
    if (this.clockSyncTimer) clearInterval(this.clockSyncTimer);
    this.clockFollowUpOwed = true; // B2
    // 1.0.0 (A1): at LIVE the newest block the mirror holds is the BOOT
    // block (the cache's or the bootstrap fill's) — minutes old on a cold
    // boot (2,175 blocks behind the head on the CDN boot of 2026-10-03), so
    // anchoring on it ran the projection clock that far in the past for the
    // first 300 s. It counts as already sampled; the first stream event that
    // delivers a newer block anchors the clock (the status tap).
    this.lastClockSampleBlock = Math.max(this.lastClockSampleBlock, this.liveBlockNumber);
    this.clockAwaitingLiveSample = true;
    // 1.0.2: the timer only ARMS the next sample, the same way. Until 1.0.2
    // it sampled liveBlockNumber as it stood — the newest block the stream
    // had delivered, however long ago — so the offset carried that block's
    // AGE at the read, and every projection ran that far in the past for the
    // next 300 s (a live session on 2026-10-04: clockOffsetMs −2,979 to
    // −23,977, the −23,977 sampled inside a 26 s gap between blocks). The
    // sample is taken by the next stream event that delivers a block NEWER
    // than any delivered so far, and the header read is of the newest block
    // delivered when it runs — at the end of that event's worker batch — so
    // it follows that block's delivery by one RPC round trip. On an idle
    // chain nothing is sampled and now() stays wall time + the last measured
    // offset — the post-stall rule's reasoning (see syncClock).
    this.clockSyncTimer = setInterval(() => {
      this.clockAwaitingLiveSample = true;
    }, KamiLensDaemon.CLOCK_SYNC_INTERVAL_MS);
    this.clockSyncTimer.unref?.();
  }

  /** the block the last clock sample was taken on (1.0.0, A1) */
  private lastClockSampleBlock = 0;
  /** a clock sample is ARMED: the next stream event that delivers a block
   * newer than any delivered so far (and than lastClockSampleBlock) takes it,
   * and the read runs at the end of that event's worker batch (the status tap
   * in bootstrap). Set at LIVE (1.0.0, A1), by every clock tick and by the
   * first event after a stall (1.0.2), CLOCK_FOLLOW_UP_MS after the first
   * sample following LIVE or a stall (1.0.2, B2), and again by a header read
   * that returned null or threw (1.0.2, see syncClock); cleared by the tap
   * when it takes the sample. */
  private clockAwaitingLiveSample = false;
  /** 1.0.2 (B2): set at LIVE and by a stall; the next successful sample
   * clears it and arms ONE more sample CLOCK_FOLLOW_UP_MS later */
  private clockFollowUpOwed = false;
  private clockFollowUpTimer: NodeJS.Timeout | null = null;

  /** 1.0.0 (A1), THE POST-STALL RULE: a clock sample is taken only on a block
   * NEWER than the previous sample's. Across a stream stall liveBlockNumber
   * freezes, and re-observing the frozen block's header pins now() to that
   * block's time — the projection clock stops while wall time runs on, and
   * every projection quietly computes on a past instant (up to the whole
   * stall). Skipping the sample keeps now() = wall time + the last measured
   * offset, the best estimate there is. The first event after a stall then
   * re-anchors immediately (see the status tap in bootstrap) rather than up to
   * 300 s later — since 1.0.2 by arming the sample, so it is taken by the
   * first event that delivers a newer block. While the stall lasts,
   * `degraded` carries stream-stalled and every answer is stamped stale.
   *
   * 1.0.2: called only from the status tap, once per worker batch, when an
   * armed sample was taken by an event that delivered a newer block than any
   * so far — never by the timer. It reads liveBlockNumber when it runs: the
   * newest block of that batch. A header read that returns null (a lagging
   * backend) or throws RE-ARMS the sample, so the next newer block is tried
   * rather than the next tick's. */
  private async syncClock(): Promise<void> {
    if (this.stopped || !this.liveBlockNumber) return;
    if (this.liveBlockNumber <= this.lastClockSampleBlock) return;
    const { chainId, jsonRpcUrl } = this.config;
    this.clockProvider ??= new JsonRpcProvider(
      jsonRpcUrl,
      { chainId, name: 'yominet' },
      { staticNetwork: true }
    );
    // the CLOCK sample (§3.8): this names the block whose header timestamp
    // calibrates the offset, not the mirror's position. Renamed from
    // `observedBlock` in 0.6.1 with the envelope fields it feeds (the old
    // envelope names were removed in 1.0.0).
    const clockSampleBlock = this.liveBlockNumber;
    let block: Awaited<ReturnType<JsonRpcProvider['getBlock']>>;
    try {
      block = await this.clockProvider.getBlock(clockSampleBlock);
    } catch (e) {
      this.clockAwaitingLiveSample = true;
      throw e;
    }
    if (!block) this.clockAwaitingLiveSample = true;
    if (block && clockSampleBlock > this.lastClockSampleBlock) {
      clock.observeBlockTimestamp(block.timestamp, clockSampleBlock);
      this.lastClockSampleBlock = clockSampleBlock;
      // 1.0.2 (B2): the first sample after LIVE or a stall arms one more,
      // taken by the same rule as every other (the next event that delivers
      // a newer block; the read at the end of its batch)
      if (this.clockFollowUpOwed && !this.stopped) {
        this.clockFollowUpOwed = false;
        if (this.clockFollowUpTimer) clearTimeout(this.clockFollowUpTimer);
        this.clockFollowUpTimer = setTimeout(() => {
          this.clockFollowUpTimer = null;
          this.clockAwaitingLiveSample = true;
        }, KamiLensDaemon.CLOCK_FOLLOW_UP_MS);
        this.clockFollowUpTimer.unref?.();
      }
    }
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
    // 1.0.0 (A6): count the failure (twice if the server said "less") and
    // remember it across a restart
    this.backoffFailures += isResourceExhausted(status.msg) ? 2 : 1;
    const failures = this.persistedFailures + this.backoffFailures;
    void writeBootstrapBackoff(this.config.dataDir, {
      failures,
      lastFailureAt: new Date().toISOString(),
    });
    if (this.bootstrapAttempts > BOOTSTRAP_MAX_ATTEMPTS) {
      const error = new Error(
        `bootstrap failed after ${this.bootstrapAttempts} attempts: ${status.msg}`
      );
      log.error('[daemon]', error.message);
      // the schedule is spent: stop the pre-LIVE watchdog too, or it keeps
      // ticking against a daemon that has already given up loudly and
      // re-reports the same exhaustion every PRELIVE_STALL_MS
      this.disarmPreLiveWatchdog();
      this.rejectLive(error);
      return;
    }
    const delay = bootstrapDelayMs(failures);
    log.warn(
      `[daemon] bootstrap attempt ${this.bootstrapAttempts} failed (${status.msg}); ` +
        `retrying in ${(delay / 1000).toFixed(1)}s (${failures} consecutive failure(s))`
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
      // divergence 16 (0.6.3): the whole refresh runs in a child process.
      // The body that used to be here is workers/checkpoint/job.ts,
      // unchanged in substance — this method now only asks for it and
      // records the receipt, which is the point: nothing below this line
      // deserializes or serializes anything on this thread.
      const { report, durationMs } = await this.checkpointHost.run({
        chainId: this.config.chainId,
        worldAddress: this.config.worldAddress,
        cacheVersion: CACHE_VERSION,
        dataDir: this.config.dataDir,
        kamigazeUrl: this.config.kamigazeUrl,
        snapshotNumChunks: 10,
      });
      // the counters moved with the work, so they have to come back — a
      // nonce bump or a decode failure raised by the delta must still reach
      // `status.degraded` (tripwires.ts absorbTripwires)
      absorbTripwires(report.tripwires);
      this.checkpointCount++;
      this.lastCheckpoint = {
        blockNumber: report.blockNumber,
        kamigazeNonce: report.kamigazeNonce,
        stateEntries: report.stateEntries,
        numComponents: report.numComponents,
        numEntities: report.numEntities,
        at: new Date().toISOString(),
        durationMs: Date.now() - t0,
      };
      log.info('[daemon] checkpoint written off-thread', {
        blockNumber: report.blockNumber,
        stateEntries: report.stateEntries,
        durationMs,
        childPeakRssKb: report.peakRssKb,
      });
      // CLEARED BEFORE THE EMISSION, not in the finally alone. The
      // emission below is the one that ANNOUNCES this checkpoint, and with
      // the flag still set it announced a finished checkpoint as
      // `inFlight: true` — observed in the packaged daemon's own log line,
      // 2026-09-18. A socket poll was always correct (the finally runs
      // before any later request is served), so this is the event stream
      // only; it is still a field reading as its own opposite.
      this.checkpointInFlight = false;
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
      stateCdnUrl,
      kamidenUrl,
      chatEnabled,
      enrich,
      dataDir,
      checkpointIntervalMs,
      reconcileIntervalMs,
    } = this.config;
    const tripwires = tripwireReport();
    const sync = syncHealthReport();
    // §3.17: the mirror is KNOWN-INCOMPLETE and has not recovered on its own
    // across two reconcile passes. Every other sync counter stays out of
    // `degraded` on purpose; this one is chain correctness, which is exactly
    // what `degraded` is for.
    const unhealedStale =
      sync.unhealedRanges.length > 0 &&
      reconcileIntervalMs > 0 &&
      unhealedForMs() > 2 * reconcileIntervalMs;
    // 1.0.0 (A2): the reconcile has work (the mirror has applied past what
    // it has verified) and reconciledThrough has not moved for more than two
    // intervals — a backend lagging for that long, or reads failing. The
    // seconds are measured from its last advance (or its seeding).
    const reconcileStalledSec = this.reconcileStalledSec(sync, reconcileIntervalMs);
    const streamSilentMs =
      this.liveAt && this.lastStreamEventAtWallMs > 0
        ? Date.now() - this.lastStreamEventAtWallMs
        : 0;
    const streamStalled = !this.stopped && streamSilentMs > KamiLensDaemon.STREAM_STALL_MS;
    // §3.2 (0.5.2): the pre-LIVE stall is CHAIN health, so it belongs in
    // `degraded` beside the stream stall — a watcher that reads only this
    // array sees the wedge that 0.5.1 made invisible.
    const preLiveStalledMs = this.preLiveStalledForMs();
    return {
      state: this.stopped ? 'STOPPED' : (SyncState[this.syncStatus.state] as keyof typeof SyncState),
      msg: this.syncStatus.msg,
      percentage: this.syncStatus.percentage,
      liveBlockNumber: this.liveBlockNumber,
      streamSilentMs,
      bootstrapMode: this.bootstrapMode,
      resumeFromBlock: this.resumeFromBlock,
      // §3.5 (0.6.3): `inFlight` is additive and costs nothing to answer.
      // It is here because it is now ANSWERABLE — before divergence 16 a
      // `status` asked during a checkpoint did not return at all, so the
      // honest value of this field was unobservable by construction. null
      // stays null: a checkpoint cannot be in flight before the first one
      // has been adopted (the interval timer starts at LIVE, after the
      // post-backfill save is read), so there is no state this hides.
      checkpoint: this.lastCheckpoint
        ? { ...this.lastCheckpoint, inFlight: this.checkpointInFlight }
        : null,
      checkpointCount: this.checkpointCount,
      tripwires,
      degraded: [
        ...(preLiveStalledMs > PRELIVE_STALL_MS
          ? [`pre-live-stall:${Math.floor(preLiveStalledMs / 1000)}s`]
          : []),
        ...(streamStalled ? [`stream-stalled:${Math.floor(streamSilentMs / 1000)}s`] : []),
        ...(unhealedStale ? [`unhealed-ranges:${sync.unhealedRanges.length}`] : []),
        ...(reconcileStalledSec !== null ? [`reconcile-stalled:${reconcileStalledSec}`] : []),
        ...Object.entries(tripwires)
          .filter(([, count]) => count > 0)
          .map(([name, count]) => `${name}:${count}`),
      ],
      kamiden: this.kamiden.getStatus(),
      rpcReads: {
        ok: this.rpcOk,
        failed: this.rpcFailed,
        ...(this.rpcLastError !== null ? { lastError: this.rpcLastError } : {}),
      },
      sync: { ...sync, reconcileIntervalMs },
      incompleteRows: incompleteRowsReport(),
      lastFullLoad: fullLoadReport(),
      // read at answer time rather than cached at construction: the
      // re-exec (§3.1) happens before the daemon exists, so the value here
      // is always this image's, and `source` is derived from the same two
      // facts the decision used so the two cannot drift
      heap: { limitMb: heapLimitMb(), source: heapSource() },
      bootstrapAttempts: this.bootstrapAttempts,
      startedAt: this.startedAt,
      liveAt: this.liveAt,
      config: {
        chainId,
        worldAddress,
        jsonRpcUrl,
        wsRpcUrl,
        kamigazeUrl,
        stateCdnUrl,
        kamidenUrl,
        chatEnabled,
        enrich,
        dataDir,
        checkpointIntervalMs,
        reconcileIntervalMs,
      },
    };
  }

  /** `reconcile-stalled:<sec>` (1.0.0, A2): seconds since reconciledThrough
   * last advanced, when that is more than two reconcile intervals AND there
   * is something to verify (the mirror has applied past it). null otherwise —
   * including before LIVE and with the reconcile switched off. */
  private reconcileStalledSec(sync: SyncHealth, reconcileIntervalMs: number): number | null {
    if (!this.liveAt || this.stopped || reconcileIntervalMs <= 0) return null;
    if (sync.reconciledThrough === null || sync.lastReconcileAdvanceAt === null) return null;
    const applied = sync.appliedThrough ?? this.liveBlockNumber;
    if (applied <= sync.reconciledThrough) return null;
    const since = Date.now() - Date.parse(sync.lastReconcileAdvanceAt);
    return since > 2 * reconcileIntervalMs ? Math.floor(since / 1000) : null;
  }

  /** `--at-least <block>` (1.0.0, A5): resolve once appliedThrough >= block,
   * or refuse with NOT_APPLIED after `maxWaitMs`. Event-driven: it wakes on
   * every advance of the mark, never polls. After CATCH_UP_AFTER_MS still
   * short, and with the background head sample at or past block + K, it asks
   * the stream for ONE proven catch-up read (the stream coalesces). */
  static readonly CATCH_UP_AFTER_MS = 1_000;

  /** `--at-least` waits released because their client disconnected */
  waitsCancelled = 0;

  waitApplied(block: number, maxWaitMs: number, signal?: AbortSignal): Promise<void> {
    const reached = () => syncHealth.appliedThrough !== null && syncHealth.appliedThrough >= block;
    if (reached()) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new Error('client disconnected'));
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        off();
        clearTimeout(timer);
        clearInterval(nudge);
        signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve();
      };
      // 1.0.0: a waiter whose client has gone away is released at once —
      // its listener, its two timers and its catch-up nudges stop with it,
      // instead of running out the max-wait for nobody
      const onAbort = () => {
        this.waitsCancelled++;
        finish(new Error('client disconnected'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const off = onAppliedAdvance(() => {
        if (reached()) finish();
      });
      // after CATCH_UP_AFTER_MS, and every CATCH_UP_AFTER_MS after that while
      // still short, ask for a catch-up once the sampled head is past the
      // block (the proof covers h1 - 1); the stream runs one at a time
      const nudge = setInterval(() => {
        const head = this.headSample?.blockNumber;
        if (!reached() && head !== undefined && head >= block + 1) syncHooks.requestCatchUp?.(block);
      }, KamiLensDaemon.CATCH_UP_AFTER_MS);
      const timer = setTimeout(() => {
        const err = new QueryError(
          'NOT_APPLIED',
          `block ${block} was not applied within ${maxWaitMs} ms: appliedThrough=${syncHealth.appliedThrough}, ` +
            `reconciledThrough=${syncHealth.reconciledThrough}` +
            (this.headSample ? `, chain head ${this.headSample.blockNumber}` : '') +
            '. Nothing was served; retry, or read status.'
        ) as QueryError & { appliedThrough: number | null };
        err.appliedThrough = syncHealth.appliedThrough;
        finish(err);
      }, maxWaitMs);
      timer.unref?.();
      nudge.unref?.();
    });
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
    this.disarmPreLiveWatchdog();
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    if (this.clockSyncTimer) clearInterval(this.clockSyncTimer);
    if (this.clockFollowUpTimer) clearTimeout(this.clockFollowUpTimer);
    if (this.headTimer) clearInterval(this.headTimer);
    this.clockProvider?.destroy();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    // §3.5 (0.6.3), shutdown protocol. A checkpoint already in flight is
    // DRAINED rather than raced: it is doing the same work the final
    // refresh would do, and starting a second one beside it is how two
    // writers end up in one file. The drain is bounded and ends in a kill
    // by PID; the file is safe at every instant either way, because
    // commitSnapshotFile's order leaves a valid primary or a valid `.prev`
    // and never neither (the killed-mid-checkpoint class).
    if (this.checkpointInFlight) {
      try {
        const outcome = await this.checkpointHost.drain();
        log.warn('[daemon] in-flight checkpoint drained at shutdown', { outcome });
      } catch (e) {
        log.error('[daemon] draining the checkpoint child failed', e);
      }
    } else if (this.liveAt && this.config.kamigazeUrl) {
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
