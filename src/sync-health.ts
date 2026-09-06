// kami-lens native module (not a port): sync-recovery counters, DESIGN §3.17.
//
// The 2026-09-06 phantom-harvest loss (L-1) was undiagnosable because the
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
// is nonzero within a minute of every healthy start — the production server
// closes the subscription every ~30-40 s by design — so routing these through
// tripwires would mark a healthy daemon permanently degraded. Exactly ONE
// condition here is a real chain-correctness fault and does reach `degraded`:
// an unhealed range that has outlived two reconcile intervals means the
// mirror is known-incomplete and has not recovered on its own.

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
  lastReconcileAt: string | null;
  /** ranges recovery could not apply, oldest first; capped */
  unhealedRanges: UnhealedRange[];
  /** wall duration of the most recent heal attempt */
  lastHealMs: number | null;
};

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
  lastReconcileAt: null,
  unhealedRanges: [],
  lastHealMs: null,
});

export const syncHealth: SyncHealth = initial();

/** When `unhealedRanges` last went from empty to non-empty (wall ms), or
 * null while it is empty. Not part of the reported block — the daemon reads
 * it to decide the `unhealed-ranges:<N>` degraded marker. */
let unhealedSinceWallMs: number | null = null;

export function syncHealthReport(): SyncHealth {
  return { ...syncHealth, unhealedRanges: syncHealth.unhealedRanges.map((r) => [r[0], r[1]]) };
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

/** Test-only: back to a fresh process's counters. */
export function resetSyncHealth(): void {
  Object.assign(syncHealth, initial());
  syncHealth.unhealedRanges.length = 0;
  unhealedSinceWallMs = null;
}
