// kami-lens native module (not a port): the sliced apply (0.6.3, L-11).
// Divergence 13 in the shared sync-path numbering (Worker.ts banner,
// SPEC §4.2).
//
// THE DEFECT THIS EXISTS FOR. `storeValues` (state/cache.ts) applies a
// values chunk with `value = await decode(...)` per row. `decode` is an
// `async function` that never awaits anything (engine/encoders/decode.ts),
// so every one of those awaits resolves on the MICROTASK queue — it never
// yields to the macrotask queue, and the macrotask queue is where socket
// reads and timers live. On a 2-vCPU box one values chunk takes ~11 s to
// apply, and for those 11 s the thread reads no socket data and fires no
// timer on time. Measured on kami-factory 2026-09-18 (L-11): the other
// in-flight chunks' body reads starved until their
// `AbortSignal.timeout(CHUNK_TIMEOUT_MS = 30 s)` — WALL clock — expired, a
// self-inflicted TimeoutError plus a full ~11 MB re-fetch; and the only
// progress the daemon's pre-LIVE stall watchdog could see was "a whole
// chunk applied", four steps for the entire load, so a chunk that needed a
// retry exceeded 90 s of fingerprint silence and the daemon tore down a
// load that was working. 14.7 µs/value-row there against 1.5 on the Mac.
//
// WHY A BUDGET IN MILLISECONDS AND NOT A ROW COUNT. The same row costs ten
// times as much on the VM as on the Mac, so any fixed row count is either
// free-and-useless on one machine or a yield-per-row tax on the other. A
// time budget makes a fast machine pay approximately nothing (it finishes a
// slice inside the budget and never parks) and a slow one park exactly as
// often as it needs to.
//
// WHY AT THE CALL SITE AND NOT INSIDE `storeValues`. `storeValues` is
// shared with the gRPC snapshot path and its body is upstream's, carrying
// exactly one divergence today (the undecodable-row skip). Slicing the
// INPUT leaves that body byte-identical — no new parameter, no hook, no
// second divergence in the row loop — and it works the same way for
// `storeEntities`, which is synchronous and could not have taken a hook at
// all without changing its signature at both its call sites.
//
// THE SLICE SIZE ADAPTS because the first slice cannot know what a row costs
// here: it starts small enough that even a very slow box pays a bounded
// first slice, then tracks the budget from what the previous slice actually
// measured.
//
// ORDERING. Slices are applied in array order, one at a time, awaited — so
// a sliced apply is indistinguishable in order from the whole-array apply it
// replaces. What DOES change is interleaving across concurrent applies, and
// that is safe because it already happens: `await decode(...)` per row means
// two concurrent values-chunk applies already interleave at ROW granularity
// today, and the chunks themselves land in whatever order the network serves
// them. See the fetchFromCdn banner for the argument in full.

/** Target wall time for one slice of applied rows. Chosen against the two
 * bounds this is here to respect: `CHUNK_TIMEOUT_MS` (30 s) needs the socket
 * serviced far more often than that, and the daemon's pre-LIVE watchdog
 * compares progress every 5 s. 50 ms is two orders of magnitude inside both
 * and is, on the measured VM, ~3,400 rows. */
export const APPLY_SLICE_MS = 50;

/** First slice, before anything has been measured. ~30 ms at the VM's
 * 14.7 µs/row and ~3 ms at the Mac's 1.5; a box ten times slower than the
 * VM would pay one 300 ms slice and then adapt. */
export const APPLY_SLICE_START_ROWS = 2_048;

/** Floor and ceiling on the adapted size. The floor keeps the yield overhead
 * from dominating on a pathologically slow row; the ceiling keeps one slice
 * from swallowing a whole chunk if a few rows happen to decode in no time. */
export const APPLY_SLICE_MIN_ROWS = 256;
export const APPLY_SLICE_MAX_ROWS = 131_072;

export type ApplySliceProfile = {
  /** ms spent INSIDE `apply`, parked time excluded — so a caller's µs/row
   * stays a measure of decoding and not of how often it yielded */
  applyMs: number;
  /** ms spent parked in setImmediate, i.e. handed back to the event loop */
  parkedMs: number;
  slices: number;
  rows: number;
};

export type ApplySliceOptions = {
  /** override the 50 ms budget (tests) */
  budgetMs?: number;
  /** override the first slice size (tests) */
  startRows?: number;
  /** called after each slice with (rowsApplied, rowsTotal) — the hook the
   * CDN loader reports row-level progress through */
  onSlice?: (rowsApplied: number, rowsTotal: number) => void;
};

/** Yield to the MACROTASK queue. `setImmediate` and not `await 0`/
 * `queueMicrotask`: the whole point is to let the loop run its I/O and timer
 * phases, which a microtask drain does not do. */
const park = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Apply `rows` through `apply` in time-budgeted slices, parking on the
 * macrotask queue between them.
 *
 * `apply` receives a contiguous, in-order slice and may be sync or async;
 * whatever it returns is awaited before the next slice starts.
 */
export async function applyInSlices<T>(
  rows: T[],
  apply: (slice: T[]) => void | Promise<void>,
  options: ApplySliceOptions = {}
): Promise<ApplySliceProfile> {
  const budgetMs = options.budgetMs ?? APPLY_SLICE_MS;
  const profile: ApplySliceProfile = { applyMs: 0, parkedMs: 0, slices: 0, rows: rows.length };
  if (rows.length === 0) return profile;

  let size = Math.max(APPLY_SLICE_MIN_ROWS, options.startRows ?? APPLY_SLICE_START_ROWS);
  let from = 0;

  while (from < rows.length) {
    const to = Math.min(from + size, rows.length);
    const applied = to - from;
    const started = performance.now();
    await apply(rows.slice(from, to));
    const elapsed = performance.now() - started;
    profile.applyMs += elapsed;
    profile.slices++;
    from = to;
    options.onSlice?.(from, rows.length);

    if (from >= rows.length) break;

    // Adapt towards the budget from what this slice actually cost:
    // next = applied * (budget / elapsed), clamped. A zero measurement (a
    // fast box against a coarse clock) would scale by Infinity, so it goes
    // straight to the ceiling instead.
    const next = elapsed > 0 ? Math.round(applied * (budgetMs / elapsed)) : APPLY_SLICE_MAX_ROWS;
    size = Math.min(APPLY_SLICE_MAX_ROWS, Math.max(APPLY_SLICE_MIN_ROWS, next));

    const parkedAt = performance.now();
    await park();
    profile.parkedMs += performance.now() - parkedAt;
  }

  return profile;
}
