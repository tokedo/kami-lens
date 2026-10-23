// kami-lens native module (not a port): sync-recovery counters, DESIGN §3.17.
//
// The 2026-09-06 phantom-harvest loss (field report 2026-09-06) was undiagnosable because the
// recovery path reported nothing: gap-fills announced themselves at DEBUG,
// a cursor that advanced over unapplied blocks announced itself not at all,
// and `status` had no field that would have shown a mirror known to be
// incomplete. These counters are that missing surface. They are process-wide
// singletons for the same reason tripwires.ts is: the stream lives inside the
// sync worker (swap point 2, in-process) and the daemon's status() has no
// handle on it.
//
// DELIBERATELY NOT TRIPWIRES. Every nonzero tripwire is pushed into
// `degraded` (daemon.ts), which stamps every chain answer stale. `reconnects`
// is nonzero on a healthy daemon — the production server closed the chain
// subscription every ~35-40 s until mid-September 2026 (~1,800-2,400 closes a
// day in the Mac daemon's log, 09-06..09-14) and still closes it, and times
// it out, a few dozen times a day since: 0-3 closes plus 1-67 timeouts per day
// over 2026-09-15..10-03 (the 1.0.0 measurement), and 0-3 closes plus 3-40
// timeouts per day over 2026-10-03..10-22 (re-measured for 1.1.0 —
// docs/measurements/a6-stream-close-cadence-2026-10-23.json) — so routing
// these through tripwires would mark a healthy daemon degraded, at either
// rate, and a server that resumes closing every half minute must not either.
// Exactly ONE condition here is a real chain-correctness fault and does reach
// `degraded`: an unhealed range that has outlived two reconcile intervals
// means the mirror is known-incomplete and has not recovered on its own.

// 0.6.2 adds ONE more record here that is not a recovery counter:
// `lastFullLoad`. It lives in this module for exactly the reason the counters
// above do — the full load happens inside the sync worker (swap point 2,
// in-process) and the daemon's status() has no handle on it — and it is
// reported at `status.lastFullLoad`, NOT inside the `status.sync` block, so
// the §3.17 block keeps meaning only what it has always meant.

// 1.0.5 adds the LOG LINE for `olderWritesSkipped` (recordOlderWriteSkip,
// below): until then a skipped write was a counter and nothing else, so when a
// production daemon's reconcile repaired a write the stream path had left
// unapplied (2026-10-08, an `EntityType` write at block 34,185,948) its log
// could not say whether any of the 565 skips counted so far was that write.
// The counter is unchanged; each skip is now also one INFO line, capped.

import { log } from 'utils/logger';

/** A block range [from, to] that recovery could not apply. */
export type UnhealedRange = [number, number];

export type SyncHealth = {
  /** raw-stream (re)subscriptions after the first, since process start */
  reconnects: number;
  /** heals that completed and whose events were applied */
  gapsHealed: number;
  /** heals that did NOT apply: the RPC node was behind, or the subscription
   * was torn down mid-heal. Each one records an unhealed range. */
  gapsDeferred: number;
  /** reconcile ticks processed, including the ones whose range was empty */
  reconcilePasses: number;
  /** every block up to and including this one has been covered by a COMPLETE
   * chain range read (§3.15: a lower bound on applied state that, unlike
   * liveBlockNumber, advances even across event-less blocks). null until the
   * bootstrap gap-fill seeds it. */
  reconciledThrough: number | null;
  /** 1.0.0 (A5): every write of every block up to and including this one
   * has been APPLIED to the mirror (bootstrap fill, continuity-checked stream
   * frames, proven chain reads contiguous with it). Written by the apply path
   * only — never ahead of what the mirror holds. null before LIVE. */
  appliedThrough: number | null;
  lastReconcileAt: string | null;
  /** ranges recovery could not apply, oldest first; capped */
  unhealedRanges: UnhealedRange[];
  /** wall duration of the most recent heal attempt */
  lastHealMs: number | null;
  /** 1.0.0 (A2(a)): chunk reads the batch proof caught short — a backend
   * whose own head was below the chunk's end answered, and the answer was
   * NOT taken as complete. Each one is a regression the 0.6.x reconcile
   * would have applied. */
  shortReads: number;
  /** 1.0.0 (A2(c)), rule corrected in 1.0.1: updates the apply path
   * refused because the key already held a write of a LATER block, or the
   * FINAL write of the update's own block (network/setup/utils.ts). 1.0.5:
   * each one is also an INFO line, at most SKIP_LOG_CAP per window
   * (recordOlderWriteSkip). */
  olderWritesSkipped: number;
  /** 1.0.0 (A2): when reconciledThrough last ADVANCED (ISO), or null. Read
   * by the `reconcile-stalled:<sec>` marker in `degraded`. */
  lastReconcileAdvanceAt: string | null;
  /** 1.0.1, the repair tripwire: writes from the PERIODIC reconcile (not a
   * gap heal, a catch-up, or the boot window) that the apply path applied
   * AND that changed the mirror's value, for a block strictly below the
   * stream cursor as it stood when the pass started. 0 on a healthy stream:
   * the stream had already applied everything there. Each one is a WARN
   * line. Not a tripwire in the `degraded` sense — it never reaches
   * `degraded`; the write it counts is the mirror being put RIGHT. */
  reconcileRepairs: number;
  /** 1.0.1: the most recent repair; absent until there is one. */
  lastRepair?: RepairRecord;
};

/** One reconcile repair (1.0.1): the write's block, the component (its
 * registry name), the entity id, and when it was applied (ISO). */
export type RepairRecord = { block: number; component: string; entity: string; at: string };

/** Bound on the reported list. A daemon accumulating more than this many
 * distinct unhealed ranges is not going to be fixed by reporting all of
 * them; the count of dropped ranges is what matters and `gapsDeferred`
 * carries it. */
export const MAX_UNHEALED_RANGES = 64;

const initial = (): SyncHealth => ({
  reconnects: 0,
  gapsHealed: 0,
  gapsDeferred: 0,
  reconcilePasses: 0,
  reconciledThrough: null,
  appliedThrough: null,
  lastReconcileAt: null,
  unhealedRanges: [],
  lastHealMs: null,
  shortReads: 0,
  olderWritesSkipped: 0,
  lastReconcileAdvanceAt: null,
  reconcileRepairs: 0,
});

export const syncHealth: SyncHealth = initial();

/** When `unhealedRanges` last went from empty to non-empty (wall ms), or
 * null while it is empty. Not part of the reported block — the daemon reads
 * it to decide the `unhealed-ranges:<N>` degraded marker. */
let unhealedSinceWallMs: number | null = null;

export function syncHealthReport(): SyncHealth {
  const { lastRepair, ...rest } = syncHealth;
  return {
    ...rest,
    unhealedRanges: syncHealth.unhealedRanges.map((r) => [r[0], r[1]]),
    // 1.0.1: absent, not null, until there is one
    ...(lastRepair ? { lastRepair: { ...lastRepair } } : {}),
  };
}

/** Book one reconcile repair (1.0.1) — called by the apply path, which alone
 * knows whether the write was applied and whether it changed the value. */
export function recordRepair(repair: Omit<RepairRecord, 'at'>, now: Date = new Date()): void {
  syncHealth.reconcileRepairs++;
  syncHealth.lastRepair = { ...repair, at: now.toISOString() };
}

// ------------------------------------------ 1.0.5: the older-write skip line

/** Where a skipped write came from, as far as the fields that reach the apply
 * path can tell (1.0.5):
 * - `stream` — a stream frame: a log index, no transaction index, not final;
 * - `range` — a RAW chain range read (the no-stream RPC mode): a transaction
 *   index, not final;
 * - `reconcile` — the periodic reconcile above the boot frontier (its writes
 *   carry the stream cursor, `reconcileCursor`);
 * - `chain-read` — any other PROVEN chain read's final write: a gap heal, a
 *   catch-up, or the boot-window reconcile, which the apply path cannot tell
 *   apart. */
export type SkipSource = 'stream' | 'range' | 'reconcile' | 'chain-read';

const SKIP_SOURCES: readonly SkipSource[] = ['stream', 'range', 'reconcile', 'chain-read'];

/** One skipped write, as the apply path saw it (network/setup/utils.ts). */
export type OlderWriteSkip = {
  /** the component's registry name */
  component: string;
  /** the entity id, as the repair line prints it */
  entity: string;
  /** the write's block, its log index (within its transaction), its
   * transaction index (chain reads only) and whether it was block-final */
  block: number;
  logIndex: number;
  txIndex?: number;
  final: boolean;
  tx: string;
  source: SkipSource;
  /** the position the mirror held for the key: the block of the last write
   * applied, and whether that write was block-final */
  heldBlock: number;
  heldFinal: boolean;
  /** whether the skipped value equals the one the mirror holds — `same` is a
   * re-delivery, `differs` is a write the mirror declined */
  sameValue: boolean;
};

/** At most this many skip lines per window... */
export const SKIP_LOG_CAP = 20;
/** ...of this many wall-clock ms, opened by the first skip after the last
 * window closed. */
export const SKIP_LOG_WINDOW_MS = 60_000;

let skipWindow: {
  openedAt: number;
  logged: number;
  suppressed: Record<SkipSource, number>;
} | null = null;

/** Count one skipped write (the counter exactly as before) and log it: one
 * INFO line per skip, at most SKIP_LOG_CAP per window; the skips over the
 * cap are counted per source and reported in ONE summary line when the
 * window closes (flushSkipSummary). A production daemon counts ~1.5 skips a
 * minute on average (the Mac daemon, 2026-10-14: 141 in 91 min), so the cap
 * binds only on a burst; it is there so that a burst cannot drown the log. */
export function recordOlderWriteSkip(skip: OlderWriteSkip, now: number = Date.now()): void {
  // a window that closed with no batch end since: its summary goes first,
  // with the count as it stood when it closed
  if (skipWindow !== null && now - skipWindow.openedAt >= SKIP_LOG_WINDOW_MS) {
    flushSkipSummary(now);
  }
  syncHealth.olderWritesSkipped++;
  if (skipWindow === null) {
    skipWindow = {
      openedAt: now,
      logged: 0,
      suppressed: { stream: 0, range: 0, reconcile: 0, 'chain-read': 0 },
    };
  }
  if (skipWindow.logged >= SKIP_LOG_CAP) {
    skipWindow.suppressed[skip.source]++;
    return;
  }
  skipWindow.logged++;
  log.info(
    `[apply] older write skipped: ${skip.component} ${skip.entity} block=${skip.block} ` +
      `logIndex=${skip.logIndex} txIndex=${skip.txIndex ?? '-'} final=${skip.final} ` +
      `tx=${skip.tx} source=${skip.source} ` +
      `held=${skip.heldBlock}/${skip.heldFinal ? 'final' : 'open'} ` +
      `value=${skip.sameValue ? 'same' : 'differs'} ` +
      `(olderWritesSkipped=${syncHealth.olderWritesSkipped})`
  );
}

/** Called by the apply path at the end of every batch: once the window has
 * closed, one INFO line for the skips the cap held back (none if there were
 * none), and the next skip opens a new window. */
export function flushSkipSummary(now: number = Date.now()): void {
  if (skipWindow === null || now - skipWindow.openedAt < SKIP_LOG_WINDOW_MS) return;
  const { openedAt, suppressed } = skipWindow;
  skipWindow = null;
  const more = SKIP_SOURCES.reduce((n, s) => n + suppressed[s], 0);
  if (more === 0) return;
  log.info(
    `[apply] +${more} more older writes skipped, not logged ` +
      `(cap ${SKIP_LOG_CAP} per ${SKIP_LOG_WINDOW_MS / 1000} s; window opened ` +
      `${new Date(openedAt).toISOString()}): ` +
      SKIP_SOURCES.map((s) => `${s}=${suppressed[s]}`).join(' ') +
      ` (olderWritesSkipped=${syncHealth.olderWritesSkipped})`
  );
}

/** How long the mirror has been known-incomplete, in ms; 0 when it is not. */
export function unhealedForMs(now: number = Date.now()): number {
  if (syncHealth.unhealedRanges.length === 0 || unhealedSinceWallMs === null) return 0;
  return Math.max(0, now - unhealedSinceWallMs);
}

export function recordUnhealed(from: number, to: number, now: number = Date.now()): void {
  if (to < from) return;
  if (syncHealth.unhealedRanges.length === 0) unhealedSinceWallMs = now;
  // merge into an existing range that already covers or touches this one
  for (const r of syncHealth.unhealedRanges) {
    if (from >= r[0] && to <= r[1]) return;
    if (from <= r[1] + 1 && to >= r[0] - 1) {
      r[0] = Math.min(r[0], from);
      r[1] = Math.max(r[1], to);
      return;
    }
  }
  if (syncHealth.unhealedRanges.length >= MAX_UNHEALED_RANGES) {
    syncHealth.unhealedRanges.shift();
  }
  syncHealth.unhealedRanges.push([from, to]);
}

/** A completed heal of [from, to] clears every recorded range it covers, and
 * trims the ends of any range it partially covers. */
export function clearUnhealed(from: number, to: number): void {
  if (syncHealth.unhealedRanges.length === 0) return;
  const kept: UnhealedRange[] = [];
  for (const [f, t] of syncHealth.unhealedRanges) {
    if (f >= from && t <= to) continue; // fully healed
    if (t < from || f > to) {
      kept.push([f, t]); // untouched
      continue;
    }
    if (f < from) kept.push([f, Math.min(t, from - 1)]);
    if (t > to) kept.push([Math.max(f, to + 1), t]);
  }
  syncHealth.unhealedRanges.length = 0;
  syncHealth.unhealedRanges.push(...kept);
  if (syncHealth.unhealedRanges.length === 0) unhealedSinceWallMs = null;
}

/** Which source served the last full state load of this process (§3.1, 0.6.2).
 * 'cdn' = the S3/CloudFront state export; 'grpc' = the Kamigaze snapshot
 * service. `prefix` is present only on the CDN path — it is the export's own
 * key prefix, which is what identifies WHICH image was loaded (nonce and block
 * do not identify one on their own). */
export type FullLoadRecord = {
  source: 'cdn' | 'grpc';
  /** §3.1 (0.6.3): whether that load was a WHOLE image or a delta onto a
   * cache this process already had. Added because the field without it
   * misreads: a warm boot records `{source: 'grpc', seconds: 1.4}` — the
   * snapshot service's incremental fetch, which is the same function a full
   * gRPC load uses and logs through the same "[state] full load served by"
   * line — and 1.4 seconds for a full image is a number a reader will
   * either disbelieve or, worse, believe. Observed on the Mac redeploy,
   * 2026-09-18 (0.6.2 audit residual). 'full' = the cache was empty or its
   * nonce was superseded, so the whole image was fetched; 'delta' = rows
   * since the stored cursors were applied onto the existing cache. */
  kind: 'full' | 'delta';
  prefix?: string;
  block: number;
  nonce: number;
  /** wall seconds the load took */
  seconds: number;
  /** when it finished (ISO) */
  at: string;
};

/** null until a full load runs in this process — which on a WARM boot is
 * never, and reads as "this daemon resumed a cache rather than loading an
 * image". Not a fault, and distinguishable from a load that failed (that one
 * never reaches LIVE at all). */
let lastFullLoad: FullLoadRecord | null = null;

export function recordFullLoad(record: FullLoadRecord): void {
  lastFullLoad = record;
}

export function fullLoadReport(): FullLoadRecord | null {
  return lastFullLoad === null ? null : { ...lastFullLoad };
}

/** Test-only: back to a fresh process's counters. */
export function resetSyncHealth(): void {
  Object.assign(syncHealth, initial());
  delete syncHealth.lastRepair;
  syncHealth.unhealedRanges.length = 0;
  unhealedSinceWallMs = null;
  lastFullLoad = null;
  skipWindow = null;
}

// ------------------------------------------------ 1.0.0 (A5) applied marks

/** Hooks the in-process sync worker registers for the daemon (1.0.0). */
export const syncHooks: {
  /** ask the stream for an immediate proven read up to `target` (A5) */
  requestCatchUp?: (target: number) => void;
} = {};

/** Listeners called whenever appliedThrough advances (the --at-least wait). */
const appliedListeners = new Set<(appliedThrough: number) => void>();

export function onAppliedAdvance(fn: (appliedThrough: number) => void): () => void {
  appliedListeners.add(fn);
  return () => appliedListeners.delete(fn);
}

/** Act on one AppliedMark — called by the apply path AFTER the updates before
 * it have been written, never by the stream (1.0.0, A5). Returns whether the
 * reconcile bound advanced, so the caller can prune what it no longer needs
 * to remember. */
export function applyMark(mark: {
  anchor: number | null;
  through: number;
  reconciled?: boolean;
}): { reconciledAdvanced: boolean } {
  const a = syncHealth.appliedThrough;
  const anchored = mark.anchor === null || (a !== null && a >= mark.anchor);
  if (anchored && (a === null || mark.through > a)) {
    syncHealth.appliedThrough = mark.through;
    for (const fn of appliedListeners) {
      try {
        fn(mark.through);
      } catch {
        /* a listener's failure is its own */
      }
    }
  }
  let reconciledAdvanced = false;
  if (mark.reconciled) {
    const r = syncHealth.reconciledThrough;
    if (r !== null && mark.anchor !== null && r >= mark.anchor && mark.through > r) {
      syncHealth.reconciledThrough = mark.through;
      syncHealth.lastReconcileAdvanceAt = new Date().toISOString();
      reconciledAdvanced = true;
    }
  }
  return { reconciledAdvanced };
}
