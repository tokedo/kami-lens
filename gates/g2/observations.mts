// 1.2.1: where gates G2.b and G3.c find the display-parity transcription.
//
// The transcription is hand-captured from the official client by the
// operator (see gates/fixtures/g2b-observations.template.json for its shape).
// It is NOT part of the public tree: the default path below is ignored by
// git, and a machine that holds a local copy puts it there or names it with
// the environment variable. Without it the two gates are not runnable here —
// they print one SKIP line and exit 2, the gates' "not runnable here" code,
// and the gate runners (gates/lib.sh `skippable`) go on to the next part.

import { existsSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** the environment variable that names another path for the transcription */
export const OBSERVATIONS_ENV = 'G2B_OBSERVATIONS';
/** the default path (git-ignored) */
export const DEFAULT_OBSERVATIONS = path.join(REPO_ROOT, 'gates', 'fixtures', 'g2b-observations.json');

export type ObservationsLocation = {
  path: string;
  source: 'default' | typeof OBSERVATIONS_ENV;
  present: boolean;
};

export function locateObservations(env: NodeJS.ProcessEnv = process.env): ObservationsLocation {
  const override = env[OBSERVATIONS_ENV];
  const p = override ? path.resolve(override) : DEFAULT_OBSERVATIONS;
  return { path: p, source: override ? OBSERVATIONS_ENV : 'default', present: existsSync(p) };
}

/** The transcription's optional top-level `excludedKamiIndexes`: the kamis
 * the observer controls, skipped in third-party room comparisons. Absent →
 * none excluded; anything but an array of non-negative integers is refused. */
export function excludedKamiIndexes(fixture: unknown): Set<number> {
  const v = (fixture as { excludedKamiIndexes?: unknown } | null)?.excludedKamiIndexes;
  if (v === undefined) return new Set();
  if (!Array.isArray(v) || !v.every((n) => Number.isInteger(n) && n >= 0)) {
    throw new Error('excludedKamiIndexes must be an array of non-negative integers');
  }
  return new Set(v as number[]);
}

/** Locate the transcription, or print the SKIP line and exit 2. */
export function requireObservations(gate: string, env: NodeJS.ProcessEnv = process.env): string {
  const loc = locateObservations(env);
  if (!loc.present) {
    console.log(
      `SKIP ${gate} ${JSON.stringify({
        reason:
          'the hand-captured display-parity transcription is not in the public tree and no local copy is present — not runnable here',
        // repo-relative when inside the repo, so the line names no local home
        lookedUpAt: loc.path.startsWith(REPO_ROOT + path.sep) ? path.relative(REPO_ROOT, loc.path) : loc.path,
        source: loc.source,
        override: `set ${OBSERVATIONS_ENV}=<path> to read a local copy elsewhere`,
      })}`
    );
    process.exit(2);
  }
  return loc.path;
}
