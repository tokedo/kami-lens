/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/workers/sync/stream/stream.ts
 * changes:  §3.8 clock tap — one import and one line in the stream chunk
 *           handler feed each chunk's blockTimestamp to the offset-corrected
 *           clock (see src/clock.ts).
 *
 *           Divergences (DESIGN §4.1 / §3.17, field report 2026-09-06). Upstream is
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
 *              is the actual 2026-09-06 defect: the 10.5 s no-data timeout tripped
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
 *           6. RECONNECT HYGIENE. The retry ladder resets on a working
 *              subscription, which upstream never does — without it
 *              retryCount only rises and every reconnect after the fifth
 *              paid the capped 10 s for the life of the process (the stream
 *              then reconnected every ~55 s; see RECONCILE_INTERVAL_MS for
 *              the cadence now). A RESOURCE_EXHAUSTED error carrying "retry
 *              in <N>s" is honoured (rounded up, capped at 30 s) instead of
 *              being answered with a 1 s ladder that spends the very budget
 *              the limit protects. 1.0.0 (A6): the ladder is exponential WITH
 *              JITTER (1 s doubling to 10 s, drawn from [d/2, d]); a rate
 *              limit DOUBLES the current backoff (up to 5 minutes) and is
 *              never answered sooner than the server asked; and after
 *              DEAD_SERVER_TIMEOUTS consecutive no-frame timeouts — a server
 *              that accepts the subscription and then says nothing — the
 *              next resubscribe waits 60-90 s instead of hammering it every
 *              few seconds. All are logged at WARN with the delay chosen.
 *
 *           7. (1.0.0, A2/A3/A5) THE RECONCILE RUNS ON ITS OWN. It used to be a
 *              tick merged into the raw subscription's pipeline, reading
 *              under that subscription's abort signal — so the 10.5 s
 *              no-frame timeout, or any resubscribe, killed a pass mid-read.
 *              It now lives in this closure (which survives `retry`), on its
 *              own AbortController (aborted only when the stream itself
 *              ends), and emits through its own channel merged into the
 *              output. It no longer needs to be serialized with frame
 *              processing: every event now carries its real block, every
 *              proven chain read marks its collapsed writes block-FINAL
 *              (1.0.1), and the apply path never lets an older write
 *              overwrite a newer one (network/setup/utils.ts) — inside one
 *              block the stream's arrival order is the truth, and a chain
 *              read's final write beats any frame of its block — so the
 *              interleaving of the two no longer decides what the mirror
 *              holds. Each pass reads
 *              [reconciledThrough + 1, cursor] through the batch proof,
 *              stops at the first chunk the proof does not cover, and
 *              advances only to the block it proved (A2(b)). A long window
 *              (the boot window, A3) is read in paced passes of at most
 *              RECONCILE_PASS_MAX_BLOCKS, one after another, after LIVE.
 *              THE FRONTIER RULE: data loaded without a position (the state
 *              cache, the snapshot delta, a Kamigaze diff) may reflect writes
 *              up to some block F. A chain range that starts at or below F is
 *              applied only once it is proven through at least F — an in-order
 *              replay that stopped short of F could re-apply an older chain
 *              write over a value whose own position is unknown. Below that,
 *              the pass applies nothing and waits for a better proof.
 *           8. (1.0.0, A5) APPLIED MARKS. A frame that passed the continuity
 *              check carries `appliedMark: {anchor, through: frame block - 1}`
 *              — frames are one per log, in order, so a frame in block F
 *              means every log below F has been delivered — anchored on the
 *              block the stream's unbroken chain of frames started from. A
 *              reconcile pass ends in a marker update {anchor: from - 1,
 *              through: proven block, reconciled}. The apply path turns them
 *              into `appliedThrough` and `reconciledThrough`.
 *           9. (1.0.0, A5) CATCH-UP. `--at-least <block>` can ask for an
 *              immediate proven read [appliedThrough + 1, block] (bounded),
 *              through `syncHooks.requestCatchUp`; its marker anchors on the
 *              appliedThrough it started from.
 *          10. (1.0.1) THE REPAIR TRIPWIRE. A periodic pass whose range starts
 *              above the boot frontier stamps its writes with the stream
 *              cursor as it stood when the pass started (`reconcileCursor`);
 *              the apply path counts a write of a block strictly below it
 *              that it applied and that changed the mirror's value
 *              (`status.sync.reconcileRepairs`). On a healthy stream that
 *              stays 0 — the stream already applied every write of every
 *              block it moved past; the cursor's own block is excluded
 *              because the stream may still be inside it. Gap heals,
 *              catch-ups and the boot window are not stamped.
 *
 *           `createClient` is a test seam: the recovery path had no hermetic
 *           coverage at all before 0.6.0 (test/stream-heal.test.ts). Body
 *           otherwise verbatim.
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
import { syncHealth, syncHooks } from '../../../sync-health';
import {
  AppliedMark,
  MARK_TXHASH,
  NetworkComponentUpdate,
  NetworkEvent,
  NetworkEvents,
} from '../../types';
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
import { collapseLatest, HEAL_CHUNK_BLOCKS } from './heal';

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

/** Default period of the reconcile tick (§3.17). Two minutes was chosen
 * against the reconnect cadence of its day — one subscription close every
 * ~55 s over the 2026-08-26..09-06 log, ~1,800-2,400 a day through 09-14.
 * RE-MEASURED FOR 1.0.0 (A6): since 2026-09-15 the server closes the chain
 * subscription 0-3 times a day and it times out 1-67 times a day, so most
 * passes now run on a connection that has been up for hours. The interval
 * stands on its own: it bounds how long a loss the stream never noticed can
 * live, and since 1.0.0 the reconcile no longer lives inside the
 * subscription at all (divergence 7), so a server that resumes closing every
 * half minute cannot starve it either. 0 disables it, and `status.sync` says
 * so. */
export const RECONCILE_INTERVAL_MS = 120_000;

/** 1.0.0 (A3): one reconcile pass reads at most this many blocks (20 chunks
 * of 50); a longer window — the boot window — is read in consecutive paced
 * passes rather than one burst. */
export const RECONCILE_PASS_MAX_BLOCKS = 1_000;

/** 1.0.0 (A3): pause between chunk reads inside a pass, and between passes
 * while a window is still being caught up. At ~0.4-0.6 s per batched read
 * that is under two requests a second against the public RPC. */
export const RECONCILE_PACE_MS = 250;
export const RECONCILE_CATCHUP_GAP_MS = 1_000;

/** 1.0.0 (A5): an --at-least catch-up reads at most this far past
 * appliedThrough. */
export const CATCHUP_MAX_BLOCKS = 2_000;

/** The reconcile baseline, as the bootstrap hands it over (1.0.0, A3).
 * `baseline`: the block this process's loaded state may claim — the
 * PRE-DELTA cached block on a warm boot, the full load's lowest served block
 * on a cold one; reconciledThrough starts here and the first passes re-read
 * everything above it. `frontier`: the HIGHEST block any position-less data
 * loaded at boot (cache, delta, diff) could reflect — the frontier rule's F.
 * A bare number is a baseline that is also the frontier. */
export type ReconcileSeed = { baseline: number; frontier?: number };

/** A marker update: no world write, only a statement for the apply path. */
export const markerEvent = (mark: AppliedMark): NetworkComponentUpdate<Components> =>
  ({
    type: NetworkEvents.NetworkComponentUpdate,
    entity: '0',
    component: 'Void',
    value: undefined,
    blockNumber: 0,
    lastEventInTx: false,
    txHash: MARK_TXHASH,
    appliedMark: mark,
  }) as unknown as NetworkComponentUpdate<Components>;

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
   * then every reconcile tick is a counted no-op (§3.17). 1.0.0: a seed
   * object carries the frontier too (ReconcileSeed). */
  reconcileFrom$?: Observable<number | ReconcileSeed>;
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
  /** reconcile pacing overrides (1.0.0); tests use short ones */
  reconcilePaceMs?: number;
  reconcileCatchUpGapMs?: number;
  /** pass size override (1.0.0); tests use small ones */
  reconcilePassMaxBlocks?: number;
}

interface StreamTrackingState {
  expectedPrevLogIndex: number;
  expectedPrevLogBlock: number;
  isFirstMessage: boolean;
  /** 1.0.0 (A5): the block the stream's unbroken chain of frames started
   * from (the first frame's prevLogBlockNumber) — the anchor of every frame's
   * applied mark */
  chainAnchor: number | null;
  /** 1.0.0 (A2): the frontier rule's F — the highest block position-less
   * data in the mirror may reflect */
  frontier: number;
}

/** 1.0.0 (A6): the ladder — 1 s doubling to 10 s, jittered by the caller. */
const LADDER_BASE_MS = 1_000;
const LADDER_CAP_MS = 10_000;

/** Ceiling on a server-suggested retry delay. The server has been observed
 * asking for ~20 s; this bounds a pathological suggestion without ignoring
 * a reasonable one. */
export const RATE_LIMIT_DELAY_CAP_MS = 30_000;

/** 1.0.0 (A6): a repeated RESOURCE_EXHAUSTED doubles the backoff up to this. */
export const RATE_LIMIT_BACKOFF_CAP_MS = 300_000;

/** 1.0.0 (A6): this many consecutive no-frame timeouts mean a server that
 * accepts the subscription and then says nothing; the next resubscribe waits
 * at least DEAD_SERVER_MIN_MS. */
export const DEAD_SERVER_TIMEOUTS = 3;
export const DEAD_SERVER_MIN_MS = 60_000;

/** What the retry policy remembers between attempts (reset by a frame). */
export type RetryContext = { consecutiveTimeouts: number; lastDelayMs: number };

/**
 * How long to wait before resubscribing, and why (divergence, DESIGN §3.2).
 * Returns the delay CEILING; the caller jitters it (`jitteredDelay`).
 *
 * Upstream climbs a fixed ladder and ignores what the server said. All of
 * these matter to a daemon:
 *
 * - When the server answers RESOURCE_EXHAUSTED it says how long to wait
 *   ("rate limit exceeded, retry in 20s"). Climbing a 1 s ladder into a
 *   rate limit spends the budget the limit is protecting; 57 of the 59
 *   logged gap-fill failures in the 2026-08-26..09-06 daemon log were that
 *   error. The suggestion is honoured, rounded up and capped — and (1.0.0)
 *   a rate limit doubles the backoff the previous attempt used.
 * - The ladder itself is reset on success (`resetOnSuccess`), which upstream
 *   never does. Without it `retryCount` only ever rises, so from the sixth
 *   reconnect of the process onward EVERY reconnect paid the capped 10 s —
 *   and the same log shows 17,369 reconnects over eleven days, i.e. one per
 *   ~55 s. A page reload resets upstream's counter; nothing reset ours.
 * - (1.0.0) After DEAD_SERVER_TIMEOUTS consecutive no-frame timeouts the
 *   server is treated as down, not flaky: at least DEAD_SERVER_MIN_MS.
 */
export function retryDelayFor(
  error: { message?: string } | undefined,
  retryCount: number,
  ctx: RetryContext = { consecutiveTimeouts: 0, lastDelayMs: 0 }
): {
  ms: number;
  reason: 'wake' | 'rate-limit' | 'ladder' | 'dead-server';
  suggestedSec?: number;
} {
  const message = error?.message ?? '';
  if (message.includes('Wake signal')) return { ms: 0, reason: 'wake' };
  const hint = /retry in\s+([0-9]+(?:\.[0-9]+)?)\s*s/i.exec(message);
  const exhausted = /RESOURCE_EXHAUSTED|rate limit/i.test(message);
  if (exhausted) {
    const doubled = Math.min(RATE_LIMIT_BACKOFF_CAP_MS, 2 * ctx.lastDelayMs);
    if (hint) {
      const seconds = Math.ceil(Number(hint[1]));
      return {
        ms: Math.max(Math.min(seconds * 1000, RATE_LIMIT_DELAY_CAP_MS), doubled),
        reason: 'rate-limit',
        suggestedSec: seconds,
      };
    }
    return { ms: Math.max(LADDER_BASE_MS, doubled), reason: 'rate-limit' };
  }
  if (/Stream timeout/.test(message) && ctx.consecutiveTimeouts >= DEAD_SERVER_TIMEOUTS) {
    return { ms: DEAD_SERVER_MIN_MS, reason: 'dead-server' };
  }
  return { ms: Math.min(LADDER_CAP_MS, LADDER_BASE_MS * 2 ** retryCount), reason: 'ladder' };
}

/** 1.0.0 (A6): the delay actually waited. The ladder is drawn from [d/2, d];
 * a rate limit and a dead server are never answered SOONER than their floor
 * (the server's own ask, 60 s) and get up to a quarter / 30 s on top. */
export function jitteredDelay(
  chosen: ReturnType<typeof retryDelayFor>,
  random: () => number = Math.random
): number {
  if (chosen.reason === 'wake') return 0;
  if (chosen.reason === 'ladder') return Math.round(chosen.ms * (0.5 + 0.5 * random()));
  if (chosen.reason === 'dead-server') return chosen.ms + Math.round(30_000 * random());
  return chosen.ms + Math.round(chosen.ms * 0.25 * random());
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
    reconcilePaceMs = RECONCILE_PACE_MS,
    reconcileCatchUpGapMs = RECONCILE_CATCHUP_GAP_MS,
    reconcilePassMaxBlocks = RECONCILE_PASS_MAX_BLOCKS,
  } = options;
  const transformWorldEvents = createTransformWorldEvents(decode);

  // Persist across retries
  const trackingState: StreamTrackingState = {
    expectedPrevLogIndex: -1,
    expectedPrevLogBlock: -1,
    isFirstMessage: true,
    chainAnchor: null,
    frontier: -Infinity,
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

  // divergence 7 (1.0.0): the reconcile, its timer, its abort signal and its
  // output all live HERE, in the closure that survives `retry` — not in the
  // raw subscription, whose teardown (a no-frame timeout, a resubscribe) used
  // to kill a pass mid-read.
  const reconcileAbort = new AbortController();
  const reconcileOut$ = new Subject<NetworkComponentUpdate<Components>>();
  /** stream-side: the next pass starts at reconcileCursor + 1. The PUBLIC
   * reconciledThrough moves on the apply side, when the pass is applied. */
  let reconcileCursor: number | null = null;
  let reconcileRunning = false;
  let catchUpRunning = false;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let followUp: ReturnType<typeof setTimeout> | null = null;

  /** The frontier rule (divergence 7): may a proven range [from, c] be
   * applied? */
  const frontierAllows = (from: number, c: number) =>
    from > trackingState.frontier || c >= trackingState.frontier;

  /** A boot-window read in progress (divergence 7): proven chunks are HELD
   * here, pass after paced pass, until they reach the frontier — and only
   * then applied, as one collapsed range. A pass that stops short (a lagging
   * backend) keeps what it proved; the next one continues from there. */
  let held: { from: number; through: number; events: NetworkComponentUpdate<Components>[] } | null =
    null;

  const runReconcile = async (): Promise<void> => {
    if (reconcileRunning || reconcileAbort.signal.aborted) return;
    reconcileRunning = true;
    try {
      syncHealth.reconcilePasses++;
      syncHealth.lastReconcileAt = new Date().toISOString();
      const through = reconcileCursor;
      const cursor = trackingState.expectedPrevLogBlock;
      // not yet seeded, or nothing new since the last pass: a real no-op
      if (through === null || cursor < 0 || cursor <= through) return;
      const start = held ? held.through + 1 : through + 1;
      if (start > cursor) return;
      const to = Math.min(cursor, start + reconcilePassMaxBlocks - 1);
      const r = await healRange({
        from: start,
        to,
        reason: 'reconcile',
        fetchWorldEvents,
        rpcHead,
        signal: reconcileAbort.signal,
        headWaitMs,
        headPollMs,
        partial: true,
        paceMs: reconcilePaceMs,
      });
      if (!r.ok || reconcileAbort.signal.aborted) return;
      const c = r.provenThrough;
      if (c >= start) {
        if (held) {
          held.events.push(...r.events);
          held.through = c;
        } else {
          held = { from: through + 1, through: c, events: [...r.events] };
        }
      }
      if (held && frontierAllows(held.from, held.through)) {
        const range = held;
        held = null;
        settleHeal(range.from, range.through, r.ms);
        reconcileCursor = range.through;
        // divergence 10 (1.0.1): above the boot frontier, a write this pass
        // must CHANGE, for a block the stream had already moved past when the
        // pass started, is one the stream path missed — stamp the cursor so
        // the apply path can count it. The boot window (a range starting at
        // or below the frontier) corrects position-less data by design and
        // is not stamped.
        const stamp = range.from > trackingState.frontier;
        for (const e of collapseLatest(range.events)) {
          reconcileOut$.next(stamp ? { ...e, reconcileCursor: cursor } : e);
        }
        reconcileOut$.next(
          markerEvent({ anchor: range.from - 1, through: range.through, reconciled: true })
        );
      } else if (held) {
        log.info(
          `[heal] reconcile holding ${held.from}..${held.through} (${held.events.length} writes): ` +
            `the boot frontier is ${trackingState.frontier}, nothing is applied until a read is proven through it`
        );
      }
      // a window longer than one pass (the boot window): keep going, paced
      const reached = held ? held.through : (reconcileCursor ?? through);
      if (c >= start && reached < cursor - HEAL_CHUNK_BLOCKS && !reconcileAbort.signal.aborted) {
        followUp = setTimeout(() => void runReconcile(), reconcileCatchUpGapMs);
        followUp.unref?.();
      }
    } catch (e) {
      log.warn('[heal] reconcile pass failed', e);
    } finally {
      reconcileRunning = false;
    }
  };

  /** divergence 9: a bounded proven read [appliedThrough + 1, target] for an
   * --at-least waiter */
  const runCatchUp = async (target: number): Promise<void> => {
    if (catchUpRunning || reconcileAbort.signal.aborted) return;
    const a = syncHealth.appliedThrough;
    if (a === null || a >= target) return;
    catchUpRunning = true;
    try {
      const from_ = a + 1;
      const to = Math.min(target, a + CATCHUP_MAX_BLOCKS);
      const r = await healRange({
        from: from_,
        to,
        reason: 'catch-up',
        fetchWorldEvents,
        rpcHead,
        signal: reconcileAbort.signal,
        partial: true,
      });
      if (!r.ok || reconcileAbort.signal.aborted || r.provenThrough < from_) return;
      if (!frontierAllows(from_, r.provenThrough)) return;
      for (const e of r.events) reconcileOut$.next(e);
      reconcileOut$.next(markerEvent({ anchor: a, through: r.provenThrough }));
    } catch (e) {
      log.warn('[heal] catch-up read failed', e);
    } finally {
      catchUpRunning = false;
    }
  };

  if (reconcileIntervalMs > 0) {
    reconcileTimer = setInterval(() => void runReconcile(), reconcileIntervalMs);
    reconcileTimer.unref?.();
  } else {
    log.warn('[stream] periodic reconcile DISABLED (reconcileIntervalMs = 0)');
  }
  syncHooks.requestCatchUp = (target: number) => void runCatchUp(target);

  const reconcileFromSub = reconcileFrom$?.subscribe((seed) => {
    const { baseline, frontier } = typeof seed === 'number' ? { baseline: seed, frontier: seed } : seed;
    if (reconcileCursor === null || baseline > reconcileCursor) {
      log.info(
        `[heal] reconcile baseline seeded at block ${baseline}` +
          (frontier !== undefined && frontier > baseline ? ` (boot frontier ${frontier})` : '')
      );
      reconcileCursor = baseline;
      if (syncHealth.reconciledThrough === null || baseline > syncHealth.reconciledThrough) {
        syncHealth.reconciledThrough = baseline;
      }
      syncHealth.lastReconcileAdvanceAt = new Date().toISOString();
    }
    trackingState.frontier = Math.max(trackingState.frontier, frontier ?? baseline);
    // 1.0.0 (A3): the boot window is read as soon as the daemon is up, not
    // at the first interval tick two minutes later. The seed fires just
    // before the (synchronous) INITIALIZE and LIVE, so this runs after LIVE.
    if (reconcileIntervalMs > 0) {
      followUp = setTimeout(() => void runReconcile(), reconcileCatchUpGapMs);
      followUp.unref?.();
    }
  });

  /** divergence 6 (1.0.0): what the retry policy remembers; a frame resets it */
  const retryCtx: RetryContext = { consecutiveTimeouts: 0, lastDelayMs: 0 };

  /** raw (re)subscriptions, so the first one is not counted as a reconnect */
  let subscriptions = 0;

  const live$ = new Observable<NetworkEvent>((subscriber) => {
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
      onMessage: () => {
        retryCtx.consecutiveTimeouts = 0;
        retryCtx.lastDelayMs = 0;
        onMessage?.();
      },
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
      // divergence 6: reset the ladder on a working subscription. Without
      // this the count only rises and every reconnect after the fifth pays
      // the capped delay for the life of the process.
      resetOnSuccess: true,
      delay: (error, retryCount) => {
        if (/Stream timeout/.test(error?.message ?? '')) retryCtx.consecutiveTimeouts++;
        const chosen = retryDelayFor(error, retryCount, retryCtx);

        // Immediate retry on wake signal
        if (chosen.reason === 'wake') {
          log.debug('[kamigaze] Immediate retry due to wake signal');
          return timer(0);
        }

        const delayMs = jitteredDelay(chosen);
        retryCtx.lastDelayMs = delayMs;
        if (chosen.reason === 'dead-server') {
          log.warn(
            `[kamigaze] ${retryCtx.consecutiveTimeouts} consecutive no-frame timeouts — ` +
              `treating the server as down; resubscribing in ${(delayMs / 1000).toFixed(1)}s`
          );
        } else if (chosen.reason === 'rate-limit') {
          log.warn(
            `[kamigaze] rate limited — the server asked for ${chosen.suggestedSec ?? '?'}s; ` +
              `resubscribing in ${(delayMs / 1000).toFixed(1)}s (attempt ${retryCount})`
          );
        } else {
          log.warn(
            `[kamigaze] resubscribing in ${(delayMs / 1000).toFixed(1)}s (attempt ${retryCount}): ${error?.message ?? 'unknown error'}`
          );
        }

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
  );

  // divergence 7: the reconcile's own output joins the stream's here, past
  // `retry`, so a resubscribe never touches it
  return merge(live$, reconcileOut$).pipe(
    // divergence (ruling (g)1): every closure-scoped resource createStream
    // owns is released here. Upstream has no such hook because a browser tab
    // releases them by going away.
    finalize(() => {
      blockUpdateSub?.unsubscribe();
      reconcileFromSub?.unsubscribe();
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (followUp) clearTimeout(followUp);
      reconcileAbort.abort();
      reconcileOut$.complete();
      if (syncHooks.requestCatchUp) syncHooks.requestCatchUp = undefined;
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
    // check reads it. (Since 1.0.0 the reconcile is not in this pipeline at
    // all — divergence 7 — so this timeout can no longer kill one.)
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
      tap(() => onMessage?.())
    );

    let sub: Subscription | undefined;
    sub = raw$
      .pipe(
        concatMap(async (responseChunk) => {
          clock.observeBlockTimestamp(responseChunk.blockTimestamp);
          let events: NetworkComponentUpdate<Components>[] = transformWorldEvents(
            responseChunk
          ) as NetworkComponentUpdate<Components>[];

          // divergence 3: after every await, before every write
          if (closed) return [];

          if (trackingState.isFirstMessage) {
            trackingState.isFirstMessage = false;
            // divergence 8: the stream's chain of frames starts here; every
            // later frame's applied mark is anchored on this block. The
            // bootstrap fill covers through the stream's start block, so a
            // first frame whose previous log is at or below it continues the
            // boot without a hole; one that is not waits for the boot-window
            // reconcile, which re-reads (baseline, ...] regardless (A3).
            trackingState.chainAnchor = responseChunk.prevLogBlockNumber;
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
            // 1.0.1: this check compares (prevLogBlockNumber, prevLogIndex),
            // and on Yominet a log's index restarts in every transaction. So
            // a gap whose two edges carry the SAME index in the same block —
            // the last frame seen and the last frame lost, one transaction's
            // log 7 and a later transaction's log 7, say — passes it unseen. It
            // is left as it is (a frame carries no transaction index to
            // compare); the periodic reconcile re-reads every block below
            // the cursor and is what covers it, and
            // status.sync.reconcileRepairs counts what it had to fix.
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
                frontierOut: trackingState,
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
              // divergence 7: the frontier rule holds for a gap heal too — a
              // range starting at or below the boot frontier is applied only
              // if it reaches it. Otherwise it is deferred like any other
              // (cursor unmoved), and the next frame's heal is wider.
              if (!(healed.from > trackingState.frontier || healed.to >= trackingState.frontier)) {
                log.warn(
                  `[heal] gap ${healed.from}..${healed.to} ends below the boot frontier ` +
                    `${trackingState.frontier} — deferred`
                );
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

          // divergence 8: this frame passed the continuity check (or its gap
          // was healed under the proof), so once it is applied every log of
          // every block below it is in the mirror
          if (trackingState.chainAnchor !== null && responseChunk.blockNumber > 0) {
            const last = events[events.length - 1]!;
            events[events.length - 1] = {
              ...last,
              appliedMark: {
                anchor: trackingState.chainAnchor,
                through: responseChunk.blockNumber - 1,
              },
            };
          }

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
  /** the closure's tracking state, so a wide gap can raise the frontier */
  frontierOut: { frontier: number };
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
    frontierOut,
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
    diffEvents = parseGetEventsSinceResponse(
      gapResponse,
      decode,
      fromBlock,
      '[stream]'
    ) as NetworkComponentUpdate<Components>[];
    latestBlock = gapResponse.latestBlock;
    // divergence 7: these events carry no position; they may reflect writes
    // up to the diff's head, which is where the frontier rule must reach
    frontierOut.frontier = Math.max(frontierOut.frontier, latestBlock, to);
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
