/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/workers/sync/Worker.ts
 * forward-port: @ 21f419e63e0a7f6b642c255efeb89dd1c288de1c (sync-affecting
 *           bucket, ahead of the pin — SPEC §4.2): the CDN cold-boot
 *           integration (planCdnLoad -> fetchFromCdn with a gRPC fallback ->
 *           bridgeBoot) and the one "[state] full load served by" log line.
 * changes:  port hygiene (DESIGN §4.1), each a one-line divergence:
 *           1. replay floor — upstream never reads initialBlockNumber, so a
 *              fresh cache gap-fills from block 0; the port seeds the gap
 *              floor from config.initialBlockNumber when the cache carries
 *              no Kamigaze block.
 *           2. no-stream mode — fillGap receives streamServiceUrl without
 *              the non-null assertion; gapfill.ts now handles the absent
 *              URL explicitly instead of via its error path.
 *           3. getStateStore receives config.dataDir — the storage-backend
 *              injection the file-snapshot store needs (swap point 3;
 *              browser IndexedDB was ambient).
 *           4. dispose(): upstream tears the sync worker down with browser
 *              worker.terminate(), which kills its providers and streams
 *              wholesale; in-process (swap point 2) that guarantee must be
 *              explicit, so init() keeps the provider/stream disposers and
 *              dispose() runs them.
 *           5. init() catches (0.5.2): the whole bootstrap body is wrapped so
 *              a throw becomes SyncState.FAILED instead of an unhandled
 *              promise rejection. Upstream calls init() from the constructor
 *              with no catch and never awaits it — a browser tab shows the
 *              player an error and the player reloads. In-process (swap
 *              point 2) an escaping rejection reaches NOTHING: the daemon
 *              learns about failure ONLY through the LoadingState component
 *              (daemon.ts onSyncStatus/onFailed), so an exception on the
 *              bootstrap path — the provider ladder exhausting its retries
 *              being the live case — left the daemon in its last reported
 *              state forever with its bounded-retry schedule never engaged.
 *              The message is sanitized of the substring 'retrying in',
 *              which onFailed reads as "the worker is handling this itself".
 *           6. rpcHead (0.6.0, DESIGN §3.17, "L-1"): the sync worker builds
 *              the chain-head source the stream's heal precondition reads —
 *              the newest blockNumber$ value as a free first check, the HTTP
 *              provider's getBlockNumber() as the authority. Upstream has no
 *              recovery precondition to serve, because upstream trusts the
 *              Kamigaze diff. Its own wait-for-the-node ladder in blocks.ts
 *              is unreachable here: it is gated on supportsBatchQueries and
 *              the daemon sets `batch: false`.
 *           7. reconcileFrom$ (0.6.0): once fillGap has closed the bootstrap
 *              gap, every block up to streamStartBlockNumber has been read
 *              as a COMPLETE range, so that block seeds the stream's periodic
 *              reconcile baseline. Before it is seeded every reconcile tick
 *              is a counted no-op, which is what keeps the reconcile from
 *              fighting the bootstrap.
 *           8. release a dead cache BEFORE the CDN load (0.6.2): when the
 *              manifest's nonce differs from the loaded cache's and that
 *              cache is non-empty, the old cache is already useless —
 *              upstream's own fetchSnapshot would full-reload it on the same
 *              nonce test — so initialState becomes a fresh cache before
 *              fetchFromCdn runs. A browser tab can afford two 2-3 GB caches
 *              alive at once for a few seconds; the VM (2 vCPU, 4 GB heap
 *              cap, RSS 4.9 GB observed 2026-09-17, L-10) cannot. Same nonce
 *              but further behind than CDN_FULL_THRESHOLD_BLOCKS keeps the
 *              old cache, as upstream: the gRPC fallback resumes its delta
 *              from it.
 *           9. reconcileFrom$ after the BRIDGE too (0.6.2, divergence 7):
 *              the bridge closes the same window fillGap does, so the
 *              existing unconditional next() below the merge seeds the
 *              baseline on both paths — deliberately left where it is
 *              rather than duplicated into each branch, which is what would
 *              let one of them drift.
 *          10. progress fingerprint (0.6.2): the daemon's pre-LIVE stall
 *              watchdog (daemon.ts progressKey, PRELIVE_STALL_MS 90 s) sees
 *              ONLY what setLoadingState emits, so the CDN path has to emit
 *              through it like every other phase — 5 % after components,
 *              then a per-chunk percentage as each lands (values weighted
 *              90, entities 5). Measured on the G10.a cold boot; the bound
 *              itself is not touched.
 *          11. the bridge requires a STREAM url, not just a snapshot one
 *              (0.6.2, divergence 2). NOTE this is no longer a correctness
 *              requirement after divergence 12: a delta-first bridge whose
 *              gap-fill has the RPC fallback ON closes its window from the
 *              chain whether or not a streamer exists, so it would be safe
 *              here. The gate is kept as conservatism — no-stream mode goes
 *              on taking the exact path it took before this release, and
 *              changing that is not what this release is for. Stated rather
 *              than left to read as load-bearing.
 *          12. THE BRIDGE IS DELTA-FIRST, where upstream's is streamer-first
 *              (0.6.2 ruling). Upstream reads an EMPTY streamer answer as
 *              "out of range" and runs the snapshot delta only then. In the
 *              lens "empty" conflates refused / threw-and-was-swallowed /
 *              genuinely-empty / SHORT (the port skips an undecodable row
 *              where upstream aborts), and the whole bridge window sits
 *              BELOW the reconcile baseline seeded right after it — where
 *              every reconcile tick is a counted no-op by design — so a
 *              short answer would land LIVE, `degraded: []`, over a
 *              permanent hole. That is the L-1 class. So the delta runs
 *              ALWAYS (the same partial fetchSnapshot the 10-minute
 *              checkpoint already trusts, on a cache whose cursors
 *              fetchFromCdn set), then the ORDINARY fillGap from the delta
 *              head with the RPC fallback ON; a delta that throws gap-fills
 *              the full window instead. `skipRpcFallback` is never passed on
 *              this path, and bridge.ts's `gap` callback no longer takes it.
 *              Reasoning in full in bridge.ts's own banner.
 *          13. THE STATE APPLY YIELDS TO THE EVENT LOOP (0.6.3, L-11), on a
 *              50 ms time budget, in the CDN loader's values and entities
 *              applies and in the gRPC path's values apply. Upstream holds
 *              the one JS thread for a whole chunk — `await decode()` per
 *              row yields to MICROTASKS only — which on 2 vCPUs is ~11 s
 *              with no socket read and no timer serviced. Bodies in this
 *              file are untouched; the divergence lives in
 *              state/apply.ts (rationale, measurement, interleaving-safety
 *              argument), snapshot/fetchFromCdn.ts and snapshot/fetch.ts.
 *          14. PROGRESS ON ROWS, NOT WHOLE CHUNKS (0.6.3), and a chunk fetch
 *              or retry changes the message. This is divergence 10's
 *              premise taken the rest of the way: the fingerprint the stall
 *              watchdog compares moved FOUR times for an entire load, so one
 *              retried chunk plus its apply exceeded PRELIVE_STALL_MS and
 *              the daemon restarted a healthy load (cold->LIVE 271 s instead
 *              of 118 s). `PRELIVE_STALL_MS` is still not touched.
 *          15. CONCURRENT CDN CHUNK FETCHES CAPPED BY AVAILABLE PARALLELISM
 *              (0.6.3): 2 in flight at <= 2 cores, upstream's 6 otherwise.
 *              `CHUNK_TIMEOUT_MS` stays upstream's 30 s.
 *          16. THE PERIODIC CHECKPOINT RUNS OFF THE MAIN THREAD (0.6.3),
 *              which is daemon.ts's business rather than this file's and is
 *              numbered here only to keep one numbering space. See
 *              workers/checkpoint/host.ts.
 *           Type-hole fix: the snapshot catch block reads e.code on an
 *           unknown catch variable — cast to {code?: unknown} (upstream is
 *           vite-transpiled and never typechecked; no behavior change).
 *           The cache/db VERSION import resolves to the swapped snapshot
 *           version constant; the store calls resolve to the file-snapshot
 *           StateStore (swap point 3). Everything else verbatim.
 */

import {
  awaitStreamValue,
  DoWork,
  filterNullish,
  keccak256,
  streamToDefinedComputed,
} from '@mud-classic/utils';
import { Components, ComponentValue, SchemaOf } from 'engine/recs';
import { computed } from 'mobx';
import {
  bufferTime,
  concat,
  concatMap,
  filter,
  ignoreElements,
  map,
  Observable,
  of,
  Subject,
  take,
} from 'rxjs';

import { VERSION as IDB_VERSION } from 'cache/db';
import { GodID, SyncState, SyncStatus } from 'engine/constants';
import { createDecode } from 'engine/encoders';
import { createBlockNumberStream } from 'engine/executors';
import { createReconnectingProvider } from 'engine/providers';
import { log } from 'utils/logger';
import { debug as parentDebug } from '../debug';
import {
  isNetworkComponentUpdateEvent,
  NetworkComponentUpdate,
  NetworkEvent,
  NetworkEvents,
  SyncWorkerConfig,
} from '../types';
import { recordFullLoad } from '../../sync-health';
import { bridgeBoot } from './bridge';
import {
  createSnapshotClient,
  fetchFromCdn,
  fetchSnapshot,
  isRateLimited,
  planCdnLoad,
} from './snapshot';
import {
  createStateCache,
  getStateCacheEntries,
  getStateReport,
  getStateStore,
  loadStateCacheFromStore,
  saveStateCacheToStore,
  storeStateEvents,
} from './state';
import {
  createStream,
  fillGap,
  HEALTH_CHECK_BUFFER_MS,
  KEEPALIVE_INTERVAL_MS,
  type RpcHeadSource,
} from './stream';
import {
  createFetchSystemCallsFromEvents,
  createFetchWorldEventsInBlockRange,
  createLatestEventStreamRPC,
} from './utils';

const debug = parentDebug.extend('SyncWorker');

/**
 * Divergence 8 (0.6.2): should the loaded cache be released before the CDN
 * load runs?
 *
 * Named and exported rather than inlined so the divergence is directly
 * testable — driving it through initOnce would mean standing up providers and
 * a stream to assert a memory property. YES exactly when the manifest's nonce
 * disagrees with the cache's AND the cache actually holds state: the old
 * cache is then already useless (upstream's own fetchSnapshot would
 * full-reload it on the same nonce test), and keeping a reference to it while
 * fetchFromCdn builds a second multi-GB cache beside it is what puts a 2 vCPU
 * / 4 GB VM over its heap cap (RSS 4.9 GB observed 2026-09-17, L-10).
 *
 * NO when the nonce agrees, however far behind the cache is: that cache is
 * still a valid delta base, and the gRPC fallback resumes from it. NO when
 * the cache is empty, where there is nothing to release.
 */
export const shouldReleaseCacheForCdn = (
  cache: { kamigazeNonce: number; state: { size: number } },
  manifest: { nonce: number }
): boolean => manifest.nonce !== cache.kamigazeNonce && cache.state.size > 0;

export enum InputType {
  Ack,
  Config,
  Wake,
  BlockUpdate,
}
export type Config = { type: InputType.Config; data: SyncWorkerConfig };
export type Ack = { type: InputType.Ack };
export type Wake = { type: InputType.Wake; timestamp: number };
export type BlockUpdate = { type: InputType.BlockUpdate; blockNumber: number };
export const ack = { type: InputType.Ack as const };
export const createWake = (): Wake => ({ type: InputType.Wake, timestamp: Date.now() });
export const createBlockUpdate = (blockNumber: number): BlockUpdate => ({
  type: InputType.BlockUpdate,
  blockNumber,
});
export type Input = Config | Ack | Wake | BlockUpdate;

export class SyncWorker<C extends Components> implements DoWork<Input, NetworkEvent<C>[]> {
  private input$ = new Subject<Input>();
  private output$ = new Subject<NetworkEvent<C>>();
  private wakeSignal$ = new Subject<void>();
  private blockUpdate$ = new Subject<number>();
  /** seeds the stream's reconcile baseline once the bootstrap gap-fill has
   * landed (§3.17): every block up to streamStartBlockNumber is then known
   * to have been read completely. */
  private reconcileFrom$ = new Subject<number>();
  private lastMessageTime = Date.now();
  private syncState: SyncStatus = { state: SyncState.CONNECTING, msg: '', percentage: 0 };
  private config?: SyncWorkerConfig;

  private retryCount = 0;
  private retryDelays = [5000, 15000, 30000, 30000, 30000]; // ms
  private maxRetries = 5;
  private disposers: (() => void)[] = [];

  /**
   * Returns the delay (in ms) for the current retry attempt.
   */
  private getRetryDelay(): number {
    return this.retryDelays[this.retryCount - 1] || this.retryDelays[this.retryDelays.length - 1];
  }

  /**
   * Returns true if the retry count has exceeded the maximum allowed retries.
   */
  private hasExceededMaxRetries(): boolean {
    return this.retryCount > this.maxRetries;
  }
  constructor() {
    debug('creating SyncWorker');
    this.init();
  }

  /**
   * Pass a loading state component update to the main thread.
   * Can be used to indicate the initial loading state on a loading screen.
   * @param loadingState {
   *  state: {@link SyncState},
   *  msg: Message to describe the current loading step.
   *  percentage: Number between 0 and 100 to describe the loading progress.
   * }
   * @param blockNumber Optional: block number to pass in the component update.
   */
  private setLoadingState(loadingState: Partial<SyncStatus>, blockNumber = 0) {
    const newLoadingState = { ...this.syncState, ...loadingState };
    this.syncState = newLoadingState;
    const update: NetworkComponentUpdate<C> = {
      type: NetworkEvents.NetworkComponentUpdate,
      component: keccak256('component.LoadingState'),
      value: newLoadingState as unknown as ComponentValue<SchemaOf<C[keyof C]>>,
      entity: GodID,
      txHash: 'worker', // Q: would we benefit at all from modifying the txHash?
      lastEventInTx: false,
      blockNumber,
    };

    this.output$.next(update);
  }

  /**
   * Start the sync process.
   * 1. Get config
   * 2. Load historic state from snapshotter or IndexedDB cache
   * 3. Save snapshot to IndexedDB
   * 4. Start the live sync from streamer/rpc
   * 5. Fill the live-sync state gap since start
   * 6. Initialize world
   * 7. Keep in sync with streamer/rpc
   */
  private async init() {
    try {
      await this.initOnce();
    } catch (e) {
      // divergence 5: a throw on the bootstrap path must become a FAILED
      // sync state, because that component update is the only channel the
      // daemon supervises. Never an unhandled rejection.
      console.error('[SyncWorker] bootstrap threw', e);
      const raw = e instanceof Error ? e.message : String(e);
      this.setLoadingState({
        state: SyncState.FAILED,
        msg: `bootstrap error: ${raw.split('retrying in').join('retrying after')}`,
      });
    }
  }

  private async initOnce() {
    performance.mark('connecting');
    this.setLoadingState({ state: SyncState.CONNECTING, msg: 'Connecting..', percentage: 0 });

    let config: SyncWorkerConfig;
    if (!this.config) {
      const computedConfig = await streamToDefinedComputed(
        this.input$.pipe(
          map((e) => (e.type === InputType.Config ? e.data : undefined)),
          filterNullish()
        )
      );
      config = computedConfig.get();
      this.config = config; // cache for future retries
    } else {
      config = this.config;
    }
    const {
      snapshotServiceUrl: snapshotUrl,
      streamServiceUrl,
      chainId,
      worldContract,
      provider: { options: providerOptions },
      fetchSystemCalls,
      reconcileIntervalMs,
    } = config;

    // Set up shared primitives
    performance.mark('setup');
    this.setLoadingState({
      state: SyncState.SETUP,
      msg: 'Starting State Sync',
      percentage: 0,
    });
    const reconnectingProvider = await createReconnectingProvider(computed(() => config.provider));
    const { providers } = reconnectingProvider;
    this.disposers.push(reconnectingProvider.dispose);
    const provider = providers.get().json;
    const indexedDB = await getStateStore(chainId, worldContract.address, IDB_VERSION, config.dataDir);
    const decode = createDecode();
    const fetchWorldEvents = createFetchWorldEventsInBlockRange(
      provider,
      worldContract,
      providerOptions?.batch,
      decode
    );

    const { blockNumber$, dispose: disposeBlockNumberStream } = createBlockNumberStream(providers);
    this.disposers.push(disposeBlockNumberStream);

    // divergence 6 (§3.17, ruling (g)3): the chain head the heal precondition
    // reads. blockNumber$ is FREE and is therefore asked first — but it rides
    // the WebSocket provider, which 0.5.2 established can go permanently
    // silent without ever erroring, so a cached value BELOW the target is not
    // trusted as a refusal and the HTTP provider is asked directly. A stale
    // head must never turn every heal into a deferral.
    let newestBlockNumber: number | undefined;
    const headSub = blockNumber$.subscribe((n) => {
      if (newestBlockNumber === undefined || n > newestBlockNumber) newestBlockNumber = n;
    });
    this.disposers.push(() => headSub.unsubscribe());
    const rpcHead: RpcHeadSource = {
      cached: () => newestBlockNumber,
      fetch: () => provider.getBlockNumber(),
    };

    /*
     * LOAD INITIAL STATE (BACKFILL)
     * - use IndexedDB Storage state cache if not expired
     * - otherwise retrieve from snapshot service
     */
    performance.mark('backfill');
    this.setLoadingState({ state: SyncState.BACKFILL, percentage: 0 });

    this.setLoadingState({ msg: 'Loading State Cache', percentage: 0 });
    let initialState = await loadStateCacheFromStore(indexedDB);
    console.log('INITIAL STATE (PRE-SYNC)', getStateReport(initialState));

    const kamigazeClient = snapshotUrl ? createSnapshotClient(snapshotUrl) : undefined;
    const setPercentage = (percentage: number) => this.setLoadingState({ percentage });
    const setMessage = (msg: string) => this.setLoadingState({ msg });
    let loadedFromCdn = false;

    if (kamigazeClient) {
      this.setLoadingState({ msg: 'Querying for Components', percentage: 0 });

      try {
        const manifest = config.stateCdnUrl
          ? await planCdnLoad(config.stateCdnUrl, kamigazeClient, initialState)
          : undefined;

        // divergence 8: the old cache is dead the moment the manifest's nonce
        // disagrees with it — fetchSnapshot's own nonce test would throw it
        // away too — so release it before a second multi-GB cache is built
        // beside it. A same-nonce cache that is merely far behind is NOT
        // released: the gRPC fallback still resumes its delta from it.
        if (manifest && shouldReleaseCacheForCdn(initialState, manifest)) {
          log.warn('[cdn] releasing a stale cache before the CDN load', {
            cachedNonce: initialState.kamigazeNonce,
            manifestNonce: manifest.nonce,
            releasedEntries: initialState.state.size,
          });
          initialState = createStateCache();
        }

        const loadStartedAt = performance.now();
        initialState = manifest
          ? await fetchFromCdn(config.stateCdnUrl!, manifest, decode, setPercentage, setMessage)
              .then((cache) => {
                loadedFromCdn = true;
                return cache;
              })
              .catch((e) => {
                log.warn('[cdn] full load failed, falling back to gRPC', e);
                return fetchSnapshot(
                  initialState,
                  kamigazeClient,
                  decode,
                  config.snapshotNumChunks ?? 10,
                  setPercentage,
                  setMessage
                );
              })
          : await fetchSnapshot(
              initialState,
              kamigazeClient,
              decode,
              config.snapshotNumChunks ?? 10,
              setPercentage,
              setMessage
            );

        // Logged on both paths on purpose: if only the CDN path announced itself, a gRPC
        // load would be indistinguishable from a log that never fired, which is exactly
        // the question this is here to answer.
        const loadSeconds = +((performance.now() - loadStartedAt) / 1000).toFixed(2);
        log.info(`[state] full load served by ${loadedFromCdn ? 'CDN' : 'gRPC'}`, {
          source: loadedFromCdn ? config.stateCdnUrl : snapshotUrl,
          cdnConfigured: !!config.stateCdnUrl,
          prefix: loadedFromCdn ? manifest?.prefix : undefined,
          block: initialState.lastKamigazeBlock,
          nonce: initialState.kamigazeNonce,
          components: initialState.components.length,
          entities: initialState.entities.length,
          values: initialState.state.size,
          seconds: loadSeconds,
        });
        // ...and RECORDED, not only logged: `status.lastFullLoad` is the field
        // a reader asks instead of grepping a log it may not have (§3.1).
        recordFullLoad({
          source: loadedFromCdn ? 'cdn' : 'grpc',
          ...(loadedFromCdn && manifest ? { prefix: manifest.prefix } : {}),
          block: initialState.lastKamigazeBlock,
          nonce: initialState.kamigazeNonce,
          seconds: loadSeconds,
          at: new Date().toISOString(),
        });
      } catch (e) {
        console.log(snapshotUrl);
        var errorMessage: string;

        if (await isRateLimited(snapshotUrl!, e)) {
          errorMessage = "You're refreshing too much! Try again in a minute or two";
        } else {
          // gRPC failures carry .code; CDN ones are fetch TypeErrors that do not, and
          // reading .code off those rendered a literal "Unknown error: undefined".
          const detail =
            (e as { code?: unknown } | null)?.code ?? (e instanceof Error ? e.message : String(e));
          errorMessage = `Unknown error: ${detail}. Can you drop this in the discord if it persists?`;
        }
        console.error('failed to retrieve state', e);
        this.setLoadingState({
          state: SyncState.FAILED,
          msg: errorMessage,
        });
        return;
      }
      this.setLoadingState({ percentage: 100 });
      console.log('INITIAL STATE (POST-SYNC)', getStateReport(initialState));
    }

    /*
     * SAVE SNAPSHOT TO INDEXEDDB
     * - Persist snapshot before starting live sync
     * - This ensures we can resume from lastKamigazeBlock on failure
     */
    this.setLoadingState({ msg: 'Saving State Cache', percentage: 0 });
    try {
      await saveStateCacheToStore(indexedDB, initialState);
    } catch (e) {
      console.error('Failed to save snapshot to IndexedDB', e);
      this.setLoadingState({
        state: SyncState.FAILED,
        msg: 'Failed to save state cache',
      });
      return;
    }

    /*
     * START LIVE SYNC
     * - Start after snapshot is saved
     * - Buffer events while filling gap
     */
    this.setLoadingState({
      state: SyncState.SETUP,
      msg: 'Initializing Event Streams',
      percentage: 0,
    });
    let outputLiveEvents = false;
    const stateCache = { current: initialState };

    const initialLiveEvents: NetworkComponentUpdate<Components>[] = [];
    const eventStream$ = streamServiceUrl
      ? createStream({
          url: streamServiceUrl!,
          worldAddress: worldContract.address,
          decode,
          includeSystemCalls: Boolean(fetchSystemCalls),
          fetchWorldEvents,
          rpcHead,
          wakeSignal$: this.wakeSignal$,
          blockUpdate$: this.blockUpdate$,
          reconcileFrom$: this.reconcileFrom$,
          reconcileIntervalMs,
          onMessage: () => {
            this.lastMessageTime = Date.now();
          },
        })
      : createLatestEventStreamRPC(
          blockNumber$,
          fetchWorldEvents,
          fetchSystemCalls ? createFetchSystemCallsFromEvents(provider) : undefined
        );

    const eventStreamSub = eventStream$.subscribe((event) => {
      if (!outputLiveEvents) {
        if (isNetworkComponentUpdateEvent(event)) initialLiveEvents.push(event);
        return;
      }
      this.output$.next(event as NetworkEvent<C>);
    });
    this.disposers.push(() => eventStreamSub.unsubscribe());

    const streamStartBlockNumber = await awaitStreamValue(blockNumber$);

    /*
     * FILL THE GAP
     * - Load events between lastKamigazeBlock and stream start
     */
    performance.mark('gapfill');
    const gapFromBlock = initialState.lastKamigazeBlock || config.initialBlockNumber || 0;
    const startString = gapFromBlock.toLocaleString();
    const endString = streamStartBlockNumber.toLocaleString();
    this.setLoadingState({
      state: SyncState.GAPFILL,
      msg: `Closing State Gap From Blocks ${startString} to ${endString}`,
      percentage: 0,
    });

    // divergence 11: the bridge branch requires a STREAM url and not merely a
    // snapshot one. After divergence 12 that is conservatism, not correctness
    // (fillGap's RPC path would close the window without a streamer) — it
    // keeps no-stream mode on the path it already took.
    // divergence 12: delta-first. `gap` is the ORDINARY fillGap — streamer
    // first, RPC fallback ON — and takes no skipRpcFallback flag, because
    // nothing on this path may answer [] for a reason it cannot name.
    const gapStateEvents =
      loadedFromCdn && kamigazeClient && streamServiceUrl
        ? await bridgeBoot({
            cache: stateCache,
            toBlock: streamStartBlockNumber,
            gap: (fromBlock) =>
              fillGap({
                kamigazeUrl: streamServiceUrl,
                decode,
                fetchWorldEvents,
                fromBlock,
                toBlock: streamStartBlockNumber,
                setPercentage,
              }),
            fetchDelta: (cache) =>
              fetchSnapshot(
                cache,
                kamigazeClient,
                decode,
                config.snapshotNumChunks ?? 10,
                setPercentage,
                setMessage
              ),
          })
        : await fillGap({
            kamigazeUrl: streamServiceUrl,
            decode,
            fetchWorldEvents,
            fromBlock: gapFromBlock,
            toBlock: streamStartBlockNumber,
            setPercentage,
          });

    // Merge gap events and live events buffered during gap fill
    storeStateEvents(stateCache.current, [...gapStateEvents, ...initialLiveEvents]);

    // divergence 7 (§3.17) + divergence 9 (0.6.2): the reconcile baseline.
    // Everything up to the stream's start block has now been read as a
    // complete range, so the periodic reconcile starts from here rather than
    // from block 0. It fires HERE, below the merge, on BOTH gap paths — the
    // bridge closes exactly the window fillGap does.
    this.reconcileFrom$.next(streamStartBlockNumber);

    /*
     * INITIALIZE STATE
     * - Output state cache entries to main thread
     */
    performance.mark('init');
    const stateCacheSize = stateCache.current.state.size;
    this.setLoadingState({
      state: SyncState.INITIALIZE,
      msg: `Initializing with ${stateCacheSize.toLocaleString()} state entries`,
      percentage: 0,
    });

    try {
      let i = 0;
      for (const update of getStateCacheEntries(stateCache.current)) {
        this.output$.next(update as NetworkEvent<C>);
        if (i++ % 5e4 === 0) {
          const percentage = Math.floor((i / stateCacheSize) * 100);
          this.setLoadingState({ percentage });
        }
      }
    } catch (e) {
      this.retryCount++;
      console.error(`Failed to output state cache, attempt ${this.retryCount}`);
      console.error(e);
      if (this.hasExceededMaxRetries()) {
        this.setLoadingState({
          state: SyncState.FAILED,
          msg: `Max retries reached. Can you drop this in the discord if it persists?`,
        });
        console.error('Error during stateCache output, maximum retries reached:', e);
        return;
      }
      const delay = this.getRetryDelay();
      this.setLoadingState({
        state: SyncState.FAILED,
        msg: `Error initializing state, retrying in ${(delay / 1000).toFixed(1)}s... (attempt ${this.retryCount}/${this.maxRetries})`,
      });
      setTimeout(() => this.init(), delay);
      return;
    }

    /*
     * FINISH
     */
    performance.mark('live');
    this.setLoadingState(
      { state: SyncState.LIVE, msg: `Streaming Live Events`, percentage: 100 },
      stateCache.current.blockNumber
    );

    outputLiveEvents = true;

    performance.measure('connection', 'connecting', 'setup');
    performance.measure('setup', 'setup', 'backfill');
    performance.measure('backfill', 'backfill', 'gapfill');
    performance.measure('gapfill', 'gapfill', 'init');
    performance.measure('initialization', 'init', 'live');
    console.log(performance.getEntriesByType('measure'));
  }

  public work(input$: Observable<Input>): Observable<NetworkEvent<C>[]> {
    input$.subscribe((e) => {
      if (e.type === InputType.Wake) {
        const timeSinceLastMessage = Date.now() - this.lastMessageTime;
        const healthThreshold = KEEPALIVE_INTERVAL_MS + HEALTH_CHECK_BUFFER_MS;
        if (timeSinceLastMessage < healthThreshold) {
          log.debug(
            `[SyncWorker] Stream healthy (last msg ${timeSinceLastMessage}ms ago), ignoring wake`
          );
          return;
        }
        console.log(
          `[SyncWorker] Stream appears dead (${timeSinceLastMessage}ms since last msg), reconnecting`
        );
        this.wakeSignal$.next();
        return;
      }
      if (e.type === InputType.BlockUpdate) {
        this.blockUpdate$.next(e.blockNumber);
        return;
      }
      this.input$.next(e);
    });
    const throttledOutput$ = new Subject<NetworkEvent<C>[]>();

    this.output$
      .pipe(
        bufferTime(33, null, 33333),
        filter((updates) => updates.length > 0),
        concatMap((updates) => {
          return concat(
            of(updates),
            input$.pipe(
              filter((e) => e.type === InputType.Ack),
              take(1),
              ignoreElements()
            )
          );
        })
      )
      .subscribe(throttledOutput$);

    return throttledOutput$;
  }

  /** In-process replacement for browser worker.terminate() (swap point 2). */
  public dispose(): void {
    for (const disposer of this.disposers.splice(0)) {
      try {
        disposer();
      } catch {
        // disposal is best-effort; a dead provider may throw on close
      }
    }
  }
}
