/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/workers/sync/Worker.ts
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
import { createSnapshotClient, fetchSnapshot, isRateLimited } from './snapshot';
import {
  createStateCache,
  getStateCacheEntries,
  getStateReport,
  getStateStore,
  loadStateCacheFromStore,
  saveStateCacheToStore,
  storeStateEvents,
} from './state';
import { createStream, fillGap, HEALTH_CHECK_BUFFER_MS, KEEPALIVE_INTERVAL_MS } from './stream';
import {
  createFetchSystemCallsFromEvents,
  createFetchWorldEventsInBlockRange,
  createLatestEventStreamRPC,
} from './utils';

const debug = parentDebug.extend('SyncWorker');

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

    if (snapshotUrl) {
      this.setLoadingState({ msg: 'Querying for Components', percentage: 0 });
      const kamigazeClient = createSnapshotClient(snapshotUrl);

      try {
        initialState = await fetchSnapshot(
          initialState,
          kamigazeClient,
          decode,
          config.snapshotNumChunks ?? 10,
          (percentage: number) => this.setLoadingState({ percentage }),
          (msg: string) => this.setLoadingState({ msg })
        );
      } catch (e) {
        console.log(snapshotUrl);
        var errorMessage: string;

        if (await isRateLimited(snapshotUrl, e)) {
          errorMessage = "You're refreshing too much! Try again in a minute or two";
        } else {
          errorMessage = `Unknown error: ${(e as { code?: unknown }).code}. Can you drop this in the discord if it persists?`;
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
          wakeSignal$: this.wakeSignal$,
          blockUpdate$: this.blockUpdate$,
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

    const gapStateEvents = await fillGap({
      kamigazeUrl: streamServiceUrl,
      decode,
      fetchWorldEvents,
      fromBlock: gapFromBlock,
      toBlock: streamStartBlockNumber,
      setPercentage: (percentage: number) => this.setLoadingState({ percentage }),
    });

    // Merge gap events and live events buffered during gap fill
    storeStateEvents(stateCache.current, [...gapStateEvents, ...initialLiveEvents]);

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
