// kami-lens native module (not a port): the checkpoint child's wire
// protocol (0.6.3, divergence 16). DESIGN §3.5.
//
// Kept in its own file with no imports from the sync graph so both ends and
// the tests agree on one definition, and so the host can be read without
// reading the job.

import type { Tripwires } from '../../tripwires';

/** What the parent asks for. Every field is a plain config value — there is
 * no secret in a checkpoint job, and there must never be one: hard rule 4
 * means nothing here may become an argv entry or a log line that carries a
 * credential. */
export type CheckpointJob = {
  chainId: number;
  worldAddress: string;
  cacheVersion: number;
  dataDir: string;
  kamigazeUrl: string;
  snapshotNumChunks: number;
};

/** The whole of what comes back. Deliberately small: the child holds a
 * multi-GB cache and none of it crosses the boundary — the file on disk is
 * the artifact, this is just the receipt. */
export type CheckpointDone = {
  kind: 'done';
  blockNumber: number;
  kamigazeNonce: number;
  stateEntries: number;
  numComponents: number;
  numEntities: number;
  /** counters the child raised, folded into the parent's totals
   * (tripwires.absorbTripwires) — otherwise they would exit with it */
  tripwires: Partial<Tripwires>;
  /** the child's own peak RSS in KB, logged by the parent. The combined
   * peak is the number the VM's memory budget is read against. */
  peakRssKb: number;
};

export type CheckpointFailed = {
  kind: 'failed';
  error: string;
};

/**
 * Sent when the delta is in hand and the SAVE is about to begin — so it
 * covers the v8.serialize of the whole cache as well as the commit sequence
 * that follows it (store.ts commitSnapshotFile). Signalled early on
 * purpose: the host uses it for one decision only, whether a shutdown that
 * has run out of patience should keep waiting a moment longer, and erring
 * early means erring towards keeping work that was about to land. It is NOT
 * what makes the commit safe — the commit ORDER is (commitSnapshotFile's
 * own note).
 */
export type CheckpointCommitting = {
  kind: 'committing';
};

export type CheckpointMessage = CheckpointDone | CheckpointFailed | CheckpointCommitting;

/** Grace for a checkpoint child at shutdown, before the commit has begun.
 * Long enough for a normal 20-35 s checkpoint on the measured VM to finish
 * (it is doing work whose loss costs the next boot a longer warm delta),
 * short enough that a wedged child cannot hold the daemon's shutdown open
 * past the ~40 s a systemd stop already takes. */
export const SHUTDOWN_GRACE_MS = 45_000;

/** Extra grace once the child says it is saving. The two renames take
 * microseconds; this covers the serialize and the fsync of a ~230 MB buffer
 * that precede them (measured 20-35 s in-process on the VM, of which the
 * serialize is most of it — so this is the tail, not the whole write). */
export const COMMIT_GRACE_MS = 10_000;

export type ShutdownDecision = 'wait' | 'kill';

/**
 * The shutdown protocol, as one decision function so it can be tested
 * without a process.
 *
 * Killing the child is safe at EVERY point (commitSnapshotFile), so this is
 * about not losing completed work, not about file integrity:
 *
 *   - inside the ordinary grace: wait
 *   - grace spent, commit not started: kill. Nothing on disk has been
 *     touched — a `.tmp` write changes neither the primary nor `.prev` —
 *     so the cost is one skipped checkpoint and the next boot resumes from
 *     the previous generation
 *   - grace spent, save started: wait up to COMMIT_GRACE_MS more, then
 *     kill anyway. A kill between the rotation and the rename leaves the
 *     primary missing and `.prev` valid, which readSnapshotFile recovers
 */
export function shutdownDecision(state: {
  elapsedMs: number;
  committing: boolean;
  graceMs?: number;
  commitGraceMs?: number;
}): ShutdownDecision {
  const grace = state.graceMs ?? SHUTDOWN_GRACE_MS;
  const commitGrace = state.commitGraceMs ?? COMMIT_GRACE_MS;
  if (state.elapsedMs < grace) return 'wait';
  if (state.committing && state.elapsedMs < grace + commitGrace) return 'wait';
  return 'kill';
}
