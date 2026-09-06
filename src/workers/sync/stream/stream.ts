/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/workers/sync/stream/stream.ts
 * changes:  §3.8 clock tap — one import and one line in the stream chunk
 *           handler feed each chunk's blockTimestamp to the offset-corrected
 *           clock (see src/clock.ts).
 *
 *           Divergences (DESIGN §4.1 / §3.17, 2026-09-06, "L-1"). Upstream is
 *           a browser tab whose worst case is a player reloading it; these
 *           four are what a daemon that must stay correct unattended for
 *           weeks needs instead. Each one is a defect observed live on
 *           2026-09-06, when seven kamis read HARVESTING for 3.5 hours after
 *           the mirror's cursor advanced over blocks it never applied:
 *
 *           1. RECOVERY READS THE CHAIN. A continuity mismatch heals through
 *              healRange (eth_getLogs on the World contract), not through
 *              Kamigaze GetEventsSince. GetEventsSince answers a DEDUPLICATED
 *              LATEST-VALUE DIFF whose store is filled log by log in step
 *              with the stream — measured 2026-09-06: a read ~1 s after a
 *              block's first log returned 49 of that block's 60 writes, and
 *              the `latestBlock` it reports names a block that may still be
 *              half-ingested. Every one of the 17,369 gap-fills in the
 *              2026-08-26..09-06 daemon log was that read at the worst
 *              possible moment. It is now reserved for gaps wider than
 *              GAP_RPC_MAX_BLOCKS, and even then the head it may have
 *              half-ingested is topped up from the chain afterwards. Never
 *              the reverse order.
 *           2. THE SUBSCRIPTION IS ABORTABLE. Upstream's inner teardown is
 *              `() => {}`, so the gRPC call outlives its subscriber and two
 *              pipelines can run against one trackingState. Each raw
 *              subscription now owns an AbortController, passed to
 *              subscribeToStream and aborted in the teardown — the same
 *              lifecycle src/kamiden.ts already uses.
 *           3. CURSOR DISCIPLINE. After any await, a `closed` flag is checked
 *              and the handler returns WITHOUT touching trackingState. This
 *              is the actual L-1 defect: the 10.5 s no-data timeout tripped
 *              during a slow gap-fill, retry resubscribed, and the old
 *              pipeline's continuation still advanced the shared cursor past
 *              blocks whose events had gone to a dead subscriber. A deferred
 *              heal likewise leaves the cursor where it is, so the next gap
 *              heal covers the widened range.
 *           4. THE NO-DATA TIMEOUT MEASURES SERVER SILENCE. It moves onto the
 *              raw frame source, ahead of the gap handling, so a slow heal
 *              can no longer tear down a healthy subscription. `onMessage`
 *              fires from the same raw tap, because the worker's own health
 *              check reads it to decide whether the stream is alive.
 *
 *           5. A PERIODIC RECONCILE, because recovery that only runs when the
 *              stream notices a gap can only fix gaps the stream noticed. A
 *              tick every RECONCILE_INTERVAL_MS re-reads
 *              [reconciledThrough + 1, cursor] from the chain, INSIDE this
 *              same serialized pipeline so it can never race a chunk. It is
 *              the backstop for every loss class the continuity check cannot
 *              see, and the thing that eventually applies a range an earlier
 *              heal had to defer.
 *
 *           Retry hygiene is described at `createClient` is a test seam: the
 *           recovery path had no hermetic coverage at all before 0.6.0
 *           (test/stream-heal.test.ts). Body otherwise verbatim.
 */

import {
  concatMap,
  finalize,
  from,
  map,
  merge,
  Observable,
  of,
  race,
  retry,
  Subject,
  Subscription,
  switchMap,
  take,
  takeUntil,
  tap,
  throwError,
  timeout,
  timer,
} from 'rxjs';

import * as clock from 'clock';

import { createKamigazeClient, KamigazeServiceClient } from 'clients/kamigaze';
import { EmptyNetworkEvent } from 'constants/stream';
import { Decode } from 'engine/encoders';
import { Components } from 'engine/recs';
import { log } from 'utils/logger';
import { syncHealth } from '../../../sync-health';
import { NetworkComponentUpdate, NetworkEvent } from '../../types';
import { createFetchWorldEventsInBlockRange } from '../utils';
import { parseGetEventsSinceResponse } from './gapfill';
import {
  abandonHeal,
  GAP_RPC_MAX_BLOCKS,
  healRange,
  settleHeal,
  type RpcHeadSource,
} from './heal';
import { createTransformWorldEvents, parseSystemCalls, TransformWorldEvents } from './transform';

export type FetchWorldEvents = ReturnType<typeof createFetchWorldEventsInBlockRange>;

/** The slice of the Kamigaze client the stream uses. Named so a hermetic
 * test can supply a scripted one (divergence 4 in the banner). */
export type StreamClient = Pick<KamigazeServiceClient, 'subscribeToStream' | 'getEventsSince'>;

/** Backend sends keepalive messages at this interval (ms) */
export const KEEPALIVE_INTERVAL_MS = 10000;

/** Buffer added to keepalive interval for stream timeout (ms) */
export const STREAM_TIMEOUT_BUFFER_MS = 500;

/** Buffer added to keepalive interval for health check threshold (ms) */
export const HEALTH_CHECK_BUFFER_MS = 2000;

/** Default period of the reconcile tick (§3.17). Two minutes is chosen
 * against the measured reconnect cadence — one subscription close every
 * ~55 s over the 2026-08-26..09-06 log — so a tick lands every second or
 * third connection and its range stays a handful of blocks wide. 0 disables
 * it, and `status.sync` says so. */
export const RECONCILE_INTERVAL_MS = 120_000;

export interface StreamOptions {
  url: string;
  worldAddress: string;
  decode: Decode;
  includeSystemCalls: boolean;
  fetchWorldEvents: FetchWorldEvents;
  /** chain head, for the heal precondition (§3.17) */
  rpcHead: RpcHeadSource;
  wakeSignal$?: Subject<void>;
  blockUpdate$?: Subject<number>;
  /** seeds reconciledThrough once the bootstrap gap-fill has landed; until
   * then every reconcile tick is a counted no-op (§3.17) */
  reconcileFrom$?: Subject<number>;
  /** 0 disables the periodic reconcile (and `status.sync` says so) */
  reconcileIntervalMs?: number;
  onMessage?: () => void;
  /** test seam (see the banner); defaults to createKamigazeClient */
  createClient?: (url: string) => StreamClient;
  /** no-data timeout override; tests use a short one */
  timeoutMs?: number;
  /** rpcHead budget overrides; tests use short ones */
  headWaitMs?: number;
  headPollMs?: number;
}

interface StreamTrackingState {
  expectedPrevLogIndex: number;
  expectedPrevLogBlock: number;
  isFirstMessage: boolean;
}

/** Fixed retry delays in seconds, capped at last value */
const RETRY_DELAYS_SECONDS = [1, 2, 3, 5, 10];

function getRetryDelay(retryCount: number): number {
  const index = Math.min(retryCount, RETRY_DELAYS_SECONDS.length - 1);
  return RETRY_DELAYS_SECONDS[index] * 1000;
}

/**
 * Create a resilient RxJS stream of NetworkEvents by subscribing to a gRPC streaming service.
 *
 * Features:
 * - Automatic timeout after 10.5s of server silence (on the raw frames)
 * - Retry with a bounded delay ladder
 * - Chain-authoritative gap healing (§3.17)
 * - System call parsing when enabled
 *
 * @param options Stream configuration options
 * @returns Observable that emits NetworkEvents
 */
export function createStream(options: StreamOptions): Observable<NetworkEvent> {
  const {
    url,
    worldAddress,
    decode,
    includeSystemCalls,
    fetchWorldEvents,
    rpcHead,
    wakeSignal$,
    blockUpdate$,
    reconcileFrom$,
    reconcileIntervalMs = RECONCILE_INTERVAL_MS,
    onMessage,
    createClient = createKamigazeClient,
    timeoutMs = KEEPALIVE_INTERVAL_MS + STREAM_TIMEOUT_BUFFER_MS,
    headWaitMs,
    headPollMs,
  } = options;
  const transformWorldEvents = createTransformWorldEvents(decode);

  // Persist across retries
  const trackingState: StreamTrackingState = {
    expectedPrevLogIndex: -1,
    expectedPrevLogBlock: -1,
    isFirstMessage: true,
  };

  // Update tracking state from main thread gapfill
  // (divergence: the subscription is KEPT so finalize can release it —
  // upstream leaks it, which a page reload hid and a daemon does not.)
  const blockUpdateSub = blockUpdate$?.subscribe((blockNumber) => {
    if (blockNumber > trackingState.expectedPrevLogBlock) {
      log.debug(`[kamigaze] Block update from main thread: ${blockNumber}`);
      trackingState.expectedPrevLogBlock = blockNumber;
    }
  });

  // The tick source and its timer live HERE, in the closure that survives
  // `retry`, for the same reason trackingState does: createRawStream is
  // rebuilt on every reconnect, and at the measured cadence (one close per
  // ~55 s) an interval owned by the raw subscription would be reset before a
  // 120 s tick ever fired.
  const reconcileTick$ = new Subject<void>();
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  if (reconcileIntervalMs > 0) {
    reconcileTimer = setInterval(() => reconcileTick$.next(), reconcileIntervalMs);
    reconcileTimer.unref?.();
  } else {
    log.warn('[stream] periodic reconcile DISABLED (reconcileIntervalMs = 0)');
  }

  const reconcileFromSub = reconcileFrom$?.subscribe((blockNumber) => {
    if (syncHealth.reconciledThrough === null || blockNumber > syncHealth.reconciledThrough) {
      log.info(`[heal] reconcile baseline seeded at block ${blockNumber}`);
      syncHealth.reconciledThrough = blockNumber;
    }
  });

  /** raw (re)subscriptions, so the first one is not counted as a reconnect */
  let subscriptions = 0;

  return new Observable<NetworkEvent>((subscriber) => {
    // Subscribe to wake signal to trigger immediate reconnection
    const wakeSub = wakeSignal$?.subscribe(() => {
      log.debug('[kamigaze] Wake signal received, forcing reconnection');
      subscriber.error(new Error('Wake signal - forcing reconnection'));
    });

    if (++subscriptions > 1) syncHealth.reconnects++;

    const innerSub = createRawStream({
      url,
      worldAddress,
      decode,
      transformWorldEvents,
      includeSystemCalls,
      fetchWorldEvents,
      rpcHead,
      trackingState,
      createClient,
      timeoutMs,
      headWaitMs,
      headPollMs,
      reconcileTick$,
      onMessage,
    }).subscribe({
      next: (v) => subscriber.next(v),
      error: (e) => subscriber.error(e),
      complete: () => subscriber.complete(),
    });

    return () => {
      wakeSub?.unsubscribe();
      innerSub.unsubscribe();
    };
  }).pipe(
    retry({
      delay: (error, retryCount) => {
        // Immediate retry on wake signal
        if (error.message?.includes('Wake signal')) {
          log.debug('[kamigaze] Immediate retry due to wake signal');
          return timer(0);
        }

        const delayMs = getRetryDelay(retryCount);
        log.debug(
          `[kamigaze] Retrying stream subscription... attempt ${retryCount} (waiting ${delayMs / 1000}s)`
        );

        // Race between normal delay and wake signal - whichever emits first wins.
        // This catches wake signals that arrive during retry delay (when wakeSub is unsubscribed).
        if (wakeSignal$) {
          return race(
            timer(delayMs), // Normal retry delay
            wakeSignal$.pipe(
              take(1), // Only react to first wake signal
              tap(() => {
                log.debug('[kamigaze] Wake signal during retry delay, retrying immediately');
              }),
              switchMap(() => timer(0)) // Emit immediately to trigger retry
            )
          );
        }

        return timer(delayMs);
      },
    }),
    // divergence (ruling (g)1): every closure-scoped resource createStream
    // owns is released here. Upstream has no such hook because a browser tab
    // releases them by going away.
    finalize(() => {
      blockUpdateSub?.unsubscribe();
      reconcileFromSub?.unsubscribe();
      if (reconcileTimer) clearInterval(reconcileTimer);
      reconcileTick$.complete();
    })
  );
}

interface RawStreamOptions {
  url: string;
  worldAddress: string;
  decode: Decode;
  transformWorldEvents: TransformWorldEvents;
  includeSystemCalls: boolean;
  fetchWorldEvents: FetchWorldEvents;
  rpcHead: RpcHeadSource;
  trackingState: StreamTrackingState;
  createClient: (url: string) => StreamClient;
  timeoutMs: number;
  headWaitMs?: number;
  headPollMs?: number;
  reconcileTick$: Subject<void>;
  onMessage?: () => void;
}

/**
 * Create a raw RxJS stream of NetworkEvents without retry resilience.
 * Use createStream for production use.
 */
function createRawStream(options: RawStreamOptions): Observable<NetworkEvent> {
  const {
    url,
    decode,
    transformWorldEvents,
    includeSystemCalls,
    fetchWorldEvents,
    rpcHead,
    trackingState,
    createClient,
    timeoutMs,
    headWaitMs,
    headPollMs,
    reconcileTick$,
    onMessage,
  } = options;

  return new Observable((subscriber) => {
    const client = createClient(url);

    // divergence 2: this subscription owns its gRPC call and cancels it on
    // teardown. Without it the old call keeps producing into a dead pipeline.
    const abort = new AbortController();
    let closed = false;

    const response = client.subscribeToStream({}, { signal: abort.signal });
    log.debug('[kamigaze] subscribeToStream', {
      expectedPrevLogBlock: trackingState.expectedPrevLogBlock,
    });

    let gapToFill = false;

    // divergence 4: the no-data timeout sits on the RAW FRAMES, so it
    // measures server silence and not the duration of a heal. onMessage
    // fires from the same tap for the same reason — the worker's health
    // check reads it, and a reconcile tick of our own must never make a
    // silent stream look alive.
    const rawDone$ = new Subject<void>();
    const raw$ = from(response).pipe(
      timeout({
        first: timeoutMs,
        each: timeoutMs,
        with: () =>
          throwError(() => {
            log.warn(`[kamigaze] Timeout - no frame received for ${timeoutMs / 1000}s`);
            return new Error(`Stream timeout - no data received for ${timeoutMs / 1000}s`);
          }),
      }),
      tap(() => onMessage?.()),
      map((chunk) => ({ kind: 'chunk' as const, chunk })),
      // the ticks below never end on their own, so merge() would never
      // complete and a clean server end would hang instead of resubscribing.
      // The raw source drives completion.
      finalize(() => rawDone$.next())
    );
    const ticks$ = reconcileTick$.pipe(
      map(() => ({ kind: 'tick' as const })),
      takeUntil(rawDone$)
    );

    /**
     * One reconcile pass, serialized with chunk processing by the same
     * concatMap. Re-reads [reconciledThrough + 1, cursor] from the chain:
     * a complete range ending AT THE CURSOR, which is exactly the condition
     * under which re-applying cannot regress a key (§3.17).
     */
    const reconcilePass = async (): Promise<NetworkComponentUpdate<Components>[]> => {
      syncHealth.reconcilePasses++;
      syncHealth.lastReconcileAt = new Date().toISOString();
      const through = syncHealth.reconciledThrough;
      const cursor = trackingState.expectedPrevLogBlock;
      // not yet seeded, or nothing new since the last pass: a real no-op
      if (through === null || cursor < 0 || cursor <= through) return [];
      const from_ = through + 1;
      const r = await healRange({
        from: from_,
        to: cursor,
        reason: 'reconcile',
        fetchWorldEvents,
        rpcHead,
        signal: abort.signal,
        headWaitMs,
        headPollMs,
      });
      if (!r.ok) return [];
      if (closed) {
        log.warn('[stream] subscription torn down during heal; reconcile NOT advanced');
        abandonHeal(from_, cursor, r.ms);
        return [];
      }
      settleHeal(from_, cursor, r.ms);
      syncHealth.reconciledThrough = cursor;
      return r.events;
    };

    let sub: Subscription | undefined;
    sub = merge(raw$, ticks$)
      .pipe(
        concatMap(async (item) => {
          if (item.kind === 'tick') return reconcilePass();
          const responseChunk = item.chunk;
          clock.observeBlockTimestamp(responseChunk.blockTimestamp);
          let events: NetworkComponentUpdate<Components>[] = (await transformWorldEvents(
            responseChunk
          )) as NetworkComponentUpdate<Components>[];

          // divergence 3: after every await, before every write
          if (closed) return [];

          if (trackingState.isFirstMessage) {
            trackingState.isFirstMessage = false;
            log.debug(
              `Stream started at block ${responseChunk.blockNumber}, logIndex ${responseChunk.logIndex}`
            );
          } else {
            if (responseChunk.prevLogBlockNumber !== trackingState.expectedPrevLogBlock) {
              log.warn(
                `Stream continuity warning: prevLogBlockNumber mismatch. Expected ${trackingState.expectedPrevLogBlock}, got ${responseChunk.prevLogBlockNumber}`
              );
              gapToFill = true;
            }
            if (responseChunk.prevLogIndex !== trackingState.expectedPrevLogIndex) {
              log.warn(
                `Stream continuity warning: prevLogIndex mismatch. Expected ${trackingState.expectedPrevLogIndex}, got ${responseChunk.prevLogIndex}`
              );
              gapToFill = true;
            }

            if (gapToFill) {
              gapToFill = false;
              const from_ = trackingState.expectedPrevLogBlock;
              const to = responseChunk.blockNumber;
              const healed = await healGap({
                client,
                decode,
                fetchWorldEvents,
                rpcHead,
                signal: abort.signal,
                from: from_,
                to,
                headWaitMs,
                headPollMs,
              });
              if (healed === null) {
                // deferred, or torn down mid-heal: the range is on the
                // unhealed list and the CURSOR STAYS PUT, so the next gap
                // heal covers the widened span. Nothing is applied.
                return [];
              }
              if (closed) {
                // the fetch landed but we are gone; it is NOT applied, so
                // the range goes back on the unhealed list (ruling (g)6)
                log.warn('[stream] subscription torn down during heal; cursor NOT advanced');
                abandonHeal(healed.from, healed.to, healed.ms);
                return [];
              }
              settleHeal(healed.from, healed.to, healed.ms);
              events = [...healed.events, ...events];
            }
          }

          if (closed) {
            log.warn('[stream] subscription torn down; cursor NOT advanced');
            return [];
          }

          trackingState.expectedPrevLogIndex = responseChunk.logIndex;
          trackingState.expectedPrevLogBlock = responseChunk.blockNumber;
          gapToFill = false;

          if (events.length === 0) return [EmptyNetworkEvent];

          if (includeSystemCalls && events.length > 0) {
            const systemCalls = parseSystemCalls(events);
            return [...events, ...systemCalls];
          }

          return events;
        }),
        concatMap((v) => of(...v))
      )
      .subscribe(subscriber);

    return () => {
      closed = true;
      abort.abort();
      sub?.unsubscribe();
    };
  });
}

interface HealGapOptions {
  client: StreamClient;
  decode: Decode;
  fetchWorldEvents: FetchWorldEvents;
  rpcHead: RpcHeadSource;
  signal: AbortSignal;
  from: number;
  to: number;
  headWaitMs?: number;
  headPollMs?: number;
}

/**
 * Heal a stream continuity gap. Chain-authoritative (§3.17): the range is
 * read from the World contract. Kamigaze's diff is used ONLY for a gap wider
 * than GAP_RPC_MAX_BLOCKS, where ~40+ chunked eth_getLogs would outlive the
 * subscription — and then the head it may have half-ingested is topped up
 * from the chain, never the reverse order.
 *
 * @returns the events to apply together with the range they cover, or null
 * when nothing may be applied (the caller must then leave the cursor alone;
 * the range is already recorded). The caller settles or abandons the range,
 * because only the caller knows whether it actually applied the events.
 */
type HealedGap = {
  events: NetworkComponentUpdate<Components>[];
  from: number;
  to: number;
  ms: number;
};

async function healGap(options: HealGapOptions): Promise<HealedGap | null> {
  const {
    client,
    decode,
    fetchWorldEvents,
    rpcHead,
    signal,
    from: fromBlock,
    to,
    headWaitMs,
    headPollMs,
  } = options;
  const span = to - fromBlock + 1;

  if (span <= GAP_RPC_MAX_BLOCKS) {
    const r = await healRange({
      from: fromBlock,
      to,
      reason: 'gap',
      fetchWorldEvents,
      rpcHead,
      signal,
      headWaitMs,
      headPollMs,
    });
    if (!r.ok) return null;
    return { events: r.events, from: fromBlock, to, ms: r.ms };
  }

  log.warn(
    `[heal] gap ${fromBlock}..${to} spans ${span} blocks (> ${GAP_RPC_MAX_BLOCKS}) — ` +
      `Kamigaze diff first, then a chain top-up of the head`
  );
  let diffEvents: NetworkComponentUpdate<Components>[] = [];
  let latestBlock: number | null = null;
  try {
    const gapResponse = await client.getEventsSince({ sinceBlock: fromBlock });
    // stamped with the range START, exactly as gapfill.ts stamps it: this
    // branch's events are a deduplicated diff, not a block's worth of logs,
    // and claiming the head for them is what the top-up below is for.
    diffEvents = (await parseGetEventsSinceResponse(
      gapResponse,
      decode,
      fromBlock,
      '[stream]'
    )) as NetworkComponentUpdate<Components>[];
    latestBlock = gapResponse.latestBlock;
  } catch (e) {
    log.warn('[heal] Kamigaze getEventsSince failed on a wide gap — falling back to the chain', e);
  }

  // the head the diff may have half-ingested, or the whole range if the diff
  // failed. Same rules either way (ruling (g)6).
  const topUpFrom = latestBlock === null ? fromBlock : Math.max(fromBlock, latestBlock - 2);
  const top = await healRange({
    from: topUpFrom,
    to,
    reason: 'gap',
    fetchWorldEvents,
    rpcHead,
    signal,
    headWaitMs,
    headPollMs,
    path: latestBlock === null ? 'rpc' : 'kamigaze+rpc',
  });
  if (!top.ok) return null;
  return { events: [...diffEvents, ...top.events], from: fromBlock, to, ms: top.ms };
}
