// kami-lens native module (not a port): the incomplete-projection counter
// (1.0.0, A1).
//
// A kami projection is INCOMPLETE when the mirror cannot give it one of the
// joins every vitals answer is computed from — its stats, its progress, its
// times, and, while it is HARVESTING, an active harvest on a resolvable node.
// queries/build.ts projectKami() is the one place that decides it. A
// single-entity read refuses with INCOMPLETE; a list read keeps the row,
// marks it `incomplete: true` and serves no vitals on it.
//
// DELIBERATELY NOT A TRIPWIRE (ruling at the 1.0.0 leg-A gate). Every nonzero
// tripwire lands in `degraded` for the life of the process, and one case here
// is legitimate: a HARVESTING kami whose harvest is written by a later log of
// the SAME transaction is, for the few milliseconds between those two stream
// frames, a kami with no active harvest. A counter that marked the daemon
// degraded forever on that would be wrong. So this is a `status` counter —
// how many, which block, when — and drives nothing.

export type IncompleteRows = {
  /** every incomplete projection seen since process start */
  total: number;
  /** single-entity reads refused with INCOMPLETE (kami, skills, an attacker) */
  refused: number;
  /** list rows served with `incomplete: true` */
  flagged: number;
  /** mirror block of the answer that saw the most recent one */
  lastBlock: number | null;
  /** when that was (ISO, wall clock) */
  lastAt: string | null;
};

const initial = (): IncompleteRows => ({
  total: 0,
  refused: 0,
  flagged: 0,
  lastBlock: null,
  lastAt: null,
});

export const incompleteRows: IncompleteRows = initial();

export function recordIncomplete(kind: 'refused' | 'flagged', blockNumber: number): void {
  incompleteRows.total += 1;
  incompleteRows[kind] += 1;
  incompleteRows.lastBlock = blockNumber;
  incompleteRows.lastAt = new Date().toISOString();
}

export function incompleteRowsReport(): IncompleteRows {
  return { ...incompleteRows };
}

/** test hook */
export function resetIncompleteRows(): void {
  Object.assign(incompleteRows, initial());
}
