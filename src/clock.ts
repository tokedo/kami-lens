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
//
// WHAT THE OFFSET ACTUALLY MEASURES (0.5.2, measured — DESIGN §3.8). The
// observation anchors on the newest block the STREAM has delivered, so the
// offset absorbs the Kamigaze pipeline's end-to-end lag and not only
// wall-clock skew. Measured live 2026-08-27 against an independent
// eth_getBlockByNumber("latest") on a machine whose wall clock was correct
// to ~1-2 s: clock.now() ran 14.2-15.3 s BEHIND chain head time, and the
// offset stepped 9.7 s between two consecutive observations — which
// clock.now() takes as a BACKWARD jump. now() is therefore NOT monotonic.
// 0.5.2 does not change the projection (that is G2.b-gated and upstream's);
// it EXPOSES the facts, through lastObservation() and the envelope's
// meta.asOf, so a caller can pad rather than guess.

/** One accepted block-timestamp observation. `blockNumber` is 0 when the
 * caller did not name the block (the stream tap does not). */
export type ClockObservation = {
  blockTimestampSec: number;
  blockNumber: number;
  atWallMs: number;
};

let offsetMs = 0;
let observedAtWallMs = 0;
let observation: ClockObservation | null = null;

/** Offset-corrected "now" in milliseconds (drop-in for Date.now()). */
export function now(): number {
  return Date.now() + offsetMs;
}

/** Feed one stream blockTimestamp (uint32 seconds). Zero/invalid is ignored
 * (an unset proto field must not teleport the clock to 1970). `blockNumber`
 * is optional and recorded verbatim so a reader can tell WHICH block the
 * correction came from (0.5.2, §3.8) — a correction of unknown provenance
 * is not evidence. */
export function observeBlockTimestamp(blockTimestampSec: number, blockNumber = 0): void {
  if (!Number.isFinite(blockTimestampSec) || blockTimestampSec <= 0) return;
  const atWallMs = Date.now();
  offsetMs = blockTimestampSec * 1000 - atWallMs;
  observedAtWallMs = atWallMs;
  observation = {
    blockTimestampSec,
    blockNumber: Number.isFinite(blockNumber) && blockNumber > 0 ? blockNumber : 0,
    atWallMs,
  };
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

/** The last accepted observation, or null when there has never been one
 * (0.5.2). NULL IS THE POINT: before the first observation the offset is 0
 * because nothing has been measured, not because the clocks agree, and
 * meta.asOf omits its four observation fields together rather than serving a
 * zero a reader would take for a measurement (§3.14). */
export function lastObservation(): ClockObservation | null {
  return observation;
}

/** Test/gate hook: forget all observations (back to upstream Date.now()). */
export function reset(): void {
  offsetMs = 0;
  observedAtWallMs = 0;
  observation = null;
}
