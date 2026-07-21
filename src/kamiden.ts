// kami-lens native module (not a port): the Kamiden feed supervisor
// (DESIGN §3.2 soft-dependency clause; PORT_PLAN M4).
//
// Upstream starts a perennial SubscribeToStream loop as a side effect of
// the first getClient() call: retry 5 s after any throw, dispatch Feed
// frames to FeedCallbacks and Message frames to MessageCallbacks. This
// module is the daemon-supervised replacement:
//
// - Explicit lifecycle: start() opens the stream, stop() aborts it. No
//   import side effects. The 5 s retry cadence is upstream's; the port
//   additionally retries when the server ENDS the stream cleanly —
//   upstream's loop only retries on throw, so a clean end silently kills
//   the feed for the rest of the browser session (per-page-load pattern);
//   a daemon must resubscribe, counted and surfaced.
// - Soft dependency: nothing here touches chain sync or daemon liveness.
//   Failures degrade exactly the kamiden-sourced rows, and the degradation
//   is surfaced per-feed in getStatus() (stream state, per-event-type
//   counters, per-unary-method health).
// - §3.10 both-layer chat exclusion: the subscription requests a
//   Messages-excluding topic filter (transport layer), and any Message
//   frames that arrive anyway are dropped at ingestion and counted —
//   MessageCallbacks is never invoked by the daemon. Topic-string
//   semantics are server-side and unverifiable at the pin (the client
//   never sets topics; the proto only documents "empty = all events"), so
//   the filter's live behavior is measured by gate G4.b and the ingestion
//   drop is the guaranteed layer.
// - Feed ring buffer: Feed-frame events are flattened into a bounded
//   sequence-stamped buffer served by the `feed` pull query; oldest
//   entries evict first, evictions counted. Arrival stamps are wall-clock
//   measurements (Kamiden events carry their own ms timestamps; the stamp
//   only records when THIS daemon saw the frame).

import {
  DroptableReveal,
  Feed,
  HarvestEnd,
  KamiCast,
  KamiMarketAccept,
  KamiMarketBuy,
  KamiMarketCancel,
  KamiMarketList,
  KamiMarketOffer,
  KamidenServiceClient,
  Kill,
  Movement,
  SacrificeReveal,
  Trade,
} from 'clients/kamiden/proto';
import { configureKamiden, getKamidenClient } from 'clients/kamiden';
import { FeedCallbacks } from 'clients/kamiden/subscriptions';
import { log } from 'utils/logger';

/** Upstream's reconnect delay (clients/kamiden/client.ts setupSubscription). */
const RETRY_DELAY_MS = 5_000;

/** Messages-excluding topic filter requested on subscribe. Best-effort
 * transport-layer exclusion in the server's vocabulary (the StreamResponse
 * carries exactly two fields: Messages and Feed); unverifiable from the
 * pinned client source — measured live by G4.b. The ingestion drop below
 * is the guaranteed layer either way. */
export const DEFAULT_STREAM_TOPICS = ['Feed'];

export type FeedEventType =
  | 'movement'
  | 'harvestEnd'
  | 'kill'
  | 'trade'
  | 'kamiCast'
  | 'droptableReveal'
  | 'sacrificeReveal'
  | 'kamiMarketList'
  | 'kamiMarketBuy'
  | 'kamiMarketOffer'
  | 'kamiMarketAccept'
  | 'kamiMarketCancel';

export type FeedEventPayload =
  | Movement
  | HarvestEnd
  | Kill
  | Trade
  | KamiCast
  | DroptableReveal
  | SacrificeReveal
  | KamiMarketList
  | KamiMarketBuy
  | KamiMarketOffer
  | KamiMarketAccept
  | KamiMarketCancel;

export type BufferedFeedEvent = {
  /** monotonic per-daemon sequence number (pagination cursor) */
  seq: number;
  /** wall-clock ms when this daemon received the frame */
  receivedAtWallMs: number;
  type: FeedEventType;
  /** the proto event, verbatim */
  event: FeedEventPayload;
};

const FEED_FIELDS: [keyof Feed, FeedEventType][] = [
  ['Movements', 'movement'],
  ['HarvestEnds', 'harvestEnd'],
  ['Kills', 'kill'],
  ['Trades', 'trade'],
  ['KamiCasts', 'kamiCast'],
  ['DroptableReveals', 'droptableReveal'],
  ['SacrificeReveals', 'sacrificeReveal'],
  ['KamiMarketLists', 'kamiMarketList'],
  ['KamiMarketBuys', 'kamiMarketBuy'],
  ['KamiMarketOffers', 'kamiMarketOffer'],
  ['KamiMarketAccepts', 'kamiMarketAccept'],
  ['KamiMarketCancels', 'kamiMarketCancel'],
];

export type StreamState = 'disabled' | 'stopped' | 'connecting' | 'live' | 'retrying';

export type UnaryHealth = {
  ok: number;
  errors: number;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
};

export type KamidenStatus = {
  configured: boolean;
  url: string | null;
  stream: {
    state: StreamState;
    topics: string[];
    startedAt: string | null;
    /** StreamResponse frames received */
    framesReceived: number;
    /** frames that carried a Feed */
    feedFrames: number;
    lastFrameAtWallMs: number;
    /** wall ms since the last frame (0 before the first) */
    silentMs: number;
    /** §3.10 ingestion drop counters — frames carrying Messages, and the
     * individual messages inside them; both must stay explained (G4.b) */
    messageFramesDropped: number;
    messagesDropped: number;
    /** resubscriptions attempted (throws and clean ends both count) */
    retries: number;
    consecutiveFailures: number;
    lastError: string | null;
    /** per-feed event counters (per-feed degradation surface, §3.2) */
    events: Record<FeedEventType, number>;
  };
  buffer: { size: number; capacity: number; evicted: number; newestSeq: number };
  /** per-unary-method health, keyed by proto method name */
  unary: Record<string, UnaryHealth>;
};

/** Thrown by unary() when Kamiden is unconfigured or a call fails — mapped
 * to the KAMIDEN_UNAVAILABLE query error code at the query layer. The
 * outage degrades exactly the kamiden-sourced rows, visibly (§3.2). */
export class KamidenUnavailableError extends Error {
  readonly code = 'KAMIDEN_UNAVAILABLE';
}

export class KamidenFeeds {
  private readonly url: string | undefined;
  private readonly topics: string[];
  private readonly capacity: number;

  private state: StreamState;
  private startedAt: string | null = null;
  private abort: AbortController | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private framesReceived = 0;
  private feedFrames = 0;
  private lastFrameAtWallMs = 0;
  private messageFramesDropped = 0;
  private messagesDropped = 0;
  private retries = 0;
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private readonly eventCounts: Record<FeedEventType, number> = {
    movement: 0,
    harvestEnd: 0,
    kill: 0,
    trade: 0,
    kamiCast: 0,
    droptableReveal: 0,
    sacrificeReveal: 0,
    kamiMarketList: 0,
    kamiMarketBuy: 0,
    kamiMarketOffer: 0,
    kamiMarketAccept: 0,
    kamiMarketCancel: 0,
  };

  private readonly buffer: BufferedFeedEvent[] = [];
  private nextSeq = 1;
  private evicted = 0;

  private readonly unaryHealth: Record<string, UnaryHealth> = {};

  constructor(options: { url?: string; topics?: string[]; bufferCapacity?: number }) {
    this.url = options.url;
    this.topics = options.topics ?? DEFAULT_STREAM_TOPICS;
    this.capacity = options.bufferCapacity ?? 4096;
    this.state = this.url ? 'stopped' : 'disabled';
    // swap point 1: the daemon, not import.meta.env, configures the client
    configureKamiden(this.url);
  }

  /** Open the supervised stream. No-op when disabled (no URL) — the
   * kamiden-sourced rows then stay degraded ('disabled'), visibly. */
  start(): void {
    if (!this.url || this.abort) return;
    this.abort = new AbortController();
    this.startedAt = new Date().toISOString();
    void this.run(this.abort.signal);
  }

  /** Abort the stream and stop retrying. Idempotent. */
  stop(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.abort?.abort();
    this.abort = null;
    if (this.state !== 'disabled') this.state = 'stopped';
  }

  private async run(signal: AbortSignal): Promise<void> {
    const client = getKamidenClient();
    if (!client) return; // unreachable when url is set; keeps the null contract
    this.state = 'connecting';
    try {
      const stream = client.subscribeToStream({ topics: this.topics }, { signal });
      for await (const response of stream) {
        this.state = 'live';
        this.consecutiveFailures = 0;
        this.ingestFrame(response);
      }
      // clean server end — upstream would silently stay dead; resubscribe
      if (!signal.aborted) this.scheduleRetry('stream ended by server');
    } catch (error) {
      if (!signal.aborted) {
        this.scheduleRetry(error instanceof Error ? error.message : String(error));
      }
    }
  }

  private scheduleRetry(reason: string): void {
    this.state = 'retrying';
    this.retries++;
    this.consecutiveFailures++;
    this.lastError = reason;
    log.warn(`[kamiden] stream error: ${reason} — retrying in ${RETRY_DELAY_MS / 1000}s`);
    this.retryTimer = setTimeout(() => {
      if (this.abort && !this.abort.signal.aborted) void this.run(this.abort.signal);
    }, RETRY_DELAY_MS);
    this.retryTimer.unref?.();
  }

  /** One StreamResponse through ingestion — the single path for live and
   * hermetic frames. §3.10 ingestion drop: stream chat is never ingested.
   * Upstream dispatches response.Messages to MessageCallbacks here; the
   * port counts and discards instead — the topic filter is asked for,
   * this drop is guaranteed. Feed dispatch is upstream's setupSubscription
   * behavior verbatim. */
  private ingestFrame(response: { Messages: unknown[]; Feed?: Feed | undefined }): void {
    this.framesReceived++;
    this.lastFrameAtWallMs = Date.now();
    if (response.Messages.length > 0) {
      this.messageFramesDropped++;
      this.messagesDropped += response.Messages.length;
    }
    if (response.Feed) {
      this.feedFrames++;
      this.ingestFeed(response.Feed);
      FeedCallbacks.forEach((cb) => cb(response.Feed!));
    }
  }

  private ingestFeed(feed: Feed): void {
    const receivedAtWallMs = Date.now();
    for (const [field, type] of FEED_FIELDS) {
      for (const event of feed[field]) {
        this.eventCounts[type]++;
        this.buffer.push({ seq: this.nextSeq++, receivedAtWallMs, type, event });
      }
    }
    if (this.buffer.length > this.capacity) {
      const excess = this.buffer.length - this.capacity;
      this.buffer.splice(0, excess);
      this.evicted += excess;
    }
  }

  /** Pull from the ring buffer: events with seq > sinceSeq, optionally one
   * type, oldest first, capped at limit. */
  read(options: { sinceSeq?: number; type?: FeedEventType; limit?: number } = {}): BufferedFeedEvent[] {
    const { sinceSeq = 0, type, limit = 500 } = options;
    const out: BufferedFeedEvent[] = [];
    for (const entry of this.buffer) {
      if (entry.seq <= sinceSeq) continue;
      if (type && entry.type !== type) continue;
      out.push(entry);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Run one unary call with per-method health accounting. Throws
   * KamidenUnavailableError when unconfigured or on any transport/service
   * failure — the caller surfaces the code, never a silent gap. */
  async unary<T>(method: string, invoke: (client: KamidenServiceClient) => Promise<T>): Promise<T> {
    const client = getKamidenClient();
    const health = (this.unaryHealth[method] ??= {
      ok: 0,
      errors: 0,
      lastOkAt: null,
      lastErrorAt: null,
      lastError: null,
    });
    if (!this.url || !client) {
      health.errors++;
      health.lastErrorAt = new Date().toISOString();
      health.lastError = 'kamiden not configured';
      throw new KamidenUnavailableError(
        `${method}: no Kamiden URL configured — kamiden-sourced rows are disabled`
      );
    }
    try {
      const result = await invoke(client);
      health.ok++;
      health.lastOkAt = new Date().toISOString();
      return result;
    } catch (error) {
      health.errors++;
      health.lastErrorAt = new Date().toISOString();
      health.lastError = error instanceof Error ? error.message : String(error);
      throw new KamidenUnavailableError(`${method}: ${health.lastError}`);
    }
  }

  getStatus(): KamidenStatus {
    return {
      configured: Boolean(this.url),
      url: this.url ?? null,
      stream: {
        state: this.state,
        topics: [...this.topics],
        startedAt: this.startedAt,
        framesReceived: this.framesReceived,
        feedFrames: this.feedFrames,
        lastFrameAtWallMs: this.lastFrameAtWallMs,
        silentMs: this.lastFrameAtWallMs > 0 ? Date.now() - this.lastFrameAtWallMs : 0,
        messageFramesDropped: this.messageFramesDropped,
        messagesDropped: this.messagesDropped,
        retries: this.retries,
        consecutiveFailures: this.consecutiveFailures,
        lastError: this.lastError,
        events: { ...this.eventCounts },
      },
      buffer: {
        size: this.buffer.length,
        capacity: this.capacity,
        evicted: this.evicted,
        newestSeq: this.nextSeq - 1,
      },
      unary: Object.fromEntries(Object.entries(this.unaryHealth).map(([k, v]) => [k, { ...v }])),
    };
  }

  /** Test/gate hook (hermetic G4.b): push one StreamResponse through the
   * EXACT ingestion path the live loop uses (same private method) — proves
   * the Message drop and the Feed dispatch without a transport, i.e. that
   * the drop works even when the transport promise (topic filter) fails. */
  ingestForTest(response: { Messages: unknown[]; Feed?: Feed | undefined }): void {
    this.ingestFrame(response);
  }
}
