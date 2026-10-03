// kami-lens native module (not a port): retry hygiene for a fleet (1.0.0, A6).
//
// Until 1.0.0 every retry in the daemon climbed a FIXED ladder with no
// jitter and no memory across attempts: the bootstrap 5…120 s and then exit 1
// (and a supervisor restart started it again from 5 s), the chain stream
// 1–10 s, Kamiden every 5 s forever. Many daemons that fail together — the
// snapshot service restarts, a region's network drops — then retry together,
// in lockstep, forever. Here instead:
//
//   - exponential backoff WITH JITTER ("equal jitter": the delay is drawn
//     from [d/2, d] for the exponential step d), so a fleet spreads out;
//   - RESOURCE_EXHAUSTED doubles the current backoff on top of the step —
//     the server is saying "less", and the answer is less;
//   - the bootstrap's failures are PERSISTED in the data directory, so a
//     daemon a supervisor restarts after it gave up keeps backing off (up to
//     ~10 minutes) instead of starting again at 5 s.

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** d * 2^step, capped. step 0 is `baseMs`. */
export function expBackoffMs(step: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, step));
}

/** Equal jitter: uniform in [ms/2, ms]. `random` is a test seam. */
export function withJitter(ms: number, random: () => number = Math.random): number {
  return Math.round(ms * (0.5 + 0.5 * random()));
}

/** Is this error the server asking for less (gRPC RESOURCE_EXHAUSTED, or the
 * snapshot service's own "rate limit" / "refreshing too much" text)? */
export function isResourceExhausted(message: string | undefined): boolean {
  return /RESOURCE_EXHAUSTED|rate limit|refreshing too much/i.test(message ?? '');
}

// ------------------------------------------------------------ Kamiden

/** Kamiden's first reconnect delay is upstream's own 5 s; it doubles per
 * consecutive failure up to 5 minutes, and RESOURCE_EXHAUSTED doubles it once
 * more. A frame resets the count (KamidenFeeds). */
export const KAMIDEN_RETRY_BASE_MS = 5_000;
export const KAMIDEN_RETRY_CAP_MS = 300_000;

export function kamidenRetryDelayMs(
  consecutiveFailures: number,
  reason: string,
  random: () => number = Math.random
): number {
  const step = Math.max(0, consecutiveFailures - 1) + (isResourceExhausted(reason) ? 1 : 0);
  return withJitter(expBackoffMs(step, KAMIDEN_RETRY_BASE_MS, KAMIDEN_RETRY_CAP_MS), random);
}

// ---------------------------------------------------------- bootstrap

export const BOOTSTRAP_RETRY_BASE_MS = 5_000;
export const BOOTSTRAP_RETRY_CAP_MS = 600_000;
/** Failures older than this are forgotten: a daemon that ran fine for an
 * hour and then failed is not in a crash loop. */
export const BOOTSTRAP_MEMORY_MS = 3_600_000;
export const BOOTSTRAP_BACKOFF_FILE = 'bootstrap-backoff.json';

export type BootstrapBackoff = { failures: number; lastFailureAt: string };

/** The delay before the NEXT attempt after `failures` consecutive failures
 * (1 = the first retry). A rate-limited failure counts double. */
export function bootstrapDelayMs(failures: number, random: () => number = Math.random): number {
  return withJitter(
    expBackoffMs(Math.max(0, failures - 1), BOOTSTRAP_RETRY_BASE_MS, BOOTSTRAP_RETRY_CAP_MS),
    random
  );
}

export async function readBootstrapBackoff(
  dataDir: string,
  now: number = Date.now()
): Promise<BootstrapBackoff | null> {
  try {
    const raw = JSON.parse(
      await fs.readFile(path.join(dataDir, BOOTSTRAP_BACKOFF_FILE), 'utf8')
    ) as Partial<BootstrapBackoff>;
    const at = Date.parse(raw.lastFailureAt ?? '');
    if (!Number.isFinite(at) || typeof raw.failures !== 'number' || raw.failures <= 0) return null;
    if (now - at > BOOTSTRAP_MEMORY_MS) return null;
    return { failures: raw.failures, lastFailureAt: raw.lastFailureAt! };
  } catch {
    return null;
  }
}

export async function writeBootstrapBackoff(dataDir: string, b: BootstrapBackoff): Promise<void> {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, BOOTSTRAP_BACKOFF_FILE), JSON.stringify(b) + '\n');
  } catch {
    /* best effort: a read-only data dir loses the memory, not the daemon */
  }
}

export async function clearBootstrapBackoff(dataDir: string): Promise<void> {
  await fs.rm(path.join(dataDir, BOOTSTRAP_BACKOFF_FILE), { force: true }).catch(() => {});
}
