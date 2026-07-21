// kami-lens native module (not a port): the DESIGN §3.8 clock.
//
// Upstream projection code reads the browser's wall clock (Date.now()); a
// daemon must not assume a synced clock. Every wall-clock read in the ported
// projection unit (app/cache/**, network/shapes/**, utils/time.ts) goes
// through clock.now() instead: wall time plus an offset learned from block
// timestamps of the streamed chain (uint32 SECONDS — Kamiden feeds are
// milliseconds; the callers keep upstream's own unit handling).
//
// Observation sources, in practice: the Kamigaze stream's blockTimestamp
// proto field arrives as 0 — the server never populates it (measured live
// 2026-07-21; that tap stays armed in workers/sync/stream in case it ever
// does) — so the operative feed is the daemon's slow-cadence RPC fetch of a
// streamed block's header timestamp (src/daemon.ts syncClock, §3.8).
//
// Properties, chosen deliberately:
// - Before the first observation the offset is 0, i.e. exactly upstream's
//   Date.now() behavior. Hermetic gates (G2.a) run in this mode so both
//   implementations read the same clock.
// - The offset is the latest single observation, not smoothed. Block
//   timestamps quantize to whole seconds and arrive with stream latency, so
//   now() can step by up to ~1 s between chunks; projection math is
//   second-granular (G2.b asserts within display rounding). What §3.8
//   actually requires is immunity to WALL-clock skew (G2.c: ±120 s), which
//   last-observation correction provides.

let offsetMs = 0;
let observedAtWallMs = 0;

/** Offset-corrected "now" in milliseconds (drop-in for Date.now()). */
export function now(): number {
  return Date.now() + offsetMs;
}

/** Feed one stream blockTimestamp (uint32 seconds). Zero/invalid is ignored
 * (an unset proto field must not teleport the clock to 1970). */
export function observeBlockTimestamp(blockTimestampSec: number): void {
  if (!Number.isFinite(blockTimestampSec) || blockTimestampSec <= 0) return;
  offsetMs = blockTimestampSec * 1000 - Date.now();
  observedAtWallMs = Date.now();
}

/** Current correction in ms (0 until the first observation). */
export function offset(): number {
  return offsetMs;
}

/** Wall-clock ms of the last accepted observation (0 if none) — for status
 * surfaces and staleness tripwires. */
export function lastObservedAtWallMs(): number {
  return observedAtWallMs;
}

/** Test/gate hook: forget all observations (back to upstream Date.now()). */
export function reset(): void {
  offsetMs = 0;
  observedAtWallMs = 0;
}
