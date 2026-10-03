// A6 — retry hygiene for a fleet: exponential backoff WITH JITTER, a
// rate limit that doubles the backoff, a dead server answered with a long
// wait, and a bootstrap whose failures survive a process restart.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BOOTSTRAP_BACKOFF_FILE,
  BOOTSTRAP_MEMORY_MS,
  BOOTSTRAP_RETRY_CAP_MS,
  KAMIDEN_RETRY_CAP_MS,
  bootstrapDelayMs,
  clearBootstrapBackoff,
  kamidenRetryDelayMs,
  readBootstrapBackoff,
  withJitter,
  writeBootstrapBackoff,
} from '../src/backoff';
import {
  DEAD_SERVER_MIN_MS,
  DEAD_SERVER_TIMEOUTS,
  RATE_LIMIT_BACKOFF_CAP_MS,
  jitteredDelay,
  retryDelayFor,
} from 'workers/sync/stream';

const top = () => 1;
const bottom = () => 0;

describe('A6: jitter spreads a fleet', () => {
  it('equal jitter draws from [d/2, d]', () => {
    expect(withJitter(10_000, top)).toBe(10_000);
    expect(withJitter(10_000, bottom)).toBe(5_000);
    const draws = new Set(Array.from({ length: 50 }, () => withJitter(10_000)));
    expect(draws.size).toBeGreaterThan(10); // not a fixed ladder
    for (const d of draws) {
      expect(d).toBeGreaterThanOrEqual(5_000);
      expect(d).toBeLessThanOrEqual(10_000);
    }
  });
});

describe('A6: the chain stream', () => {
  it('the ladder is exponential, capped at 10 s, and jittered', () => {
    expect([0, 1, 2, 3, 4, 9].map((n) => retryDelayFor({ message: 'boom' }, n).ms)).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000, 10_000,
    ]);
    expect(jitteredDelay(retryDelayFor({ message: 'boom' }, 3), bottom)).toBe(4_000);
  });

  it('RESOURCE_EXHAUSTED doubles the current backoff, never below the server s ask', () => {
    const msg = { message: 'RESOURCE_EXHAUSTED: rate limit exceeded, retry in 20s' };
    expect(retryDelayFor(msg, 0, { consecutiveTimeouts: 0, lastDelayMs: 0 }).ms).toBe(20_000);
    expect(retryDelayFor(msg, 0, { consecutiveTimeouts: 0, lastDelayMs: 25_000 }).ms).toBe(50_000);
    expect(retryDelayFor(msg, 0, { consecutiveTimeouts: 0, lastDelayMs: 400_000 }).ms).toBe(
      RATE_LIMIT_BACKOFF_CAP_MS
    );
    const r = retryDelayFor(msg, 0, { consecutiveTimeouts: 0, lastDelayMs: 0 });
    expect(jitteredDelay(r, bottom)).toBe(20_000); // jitter only ever ADDS here
    expect(jitteredDelay(r, top)).toBe(25_000);
  });

  it(`after ${DEAD_SERVER_TIMEOUTS} consecutive no-frame timeouts it waits >= 60 s`, () => {
    const timeout = { message: 'Stream timeout - no data received for 10.5s' };
    expect(retryDelayFor(timeout, 0, { consecutiveTimeouts: DEAD_SERVER_TIMEOUTS - 1, lastDelayMs: 0 }).reason).toBe('ladder');
    const dead = retryDelayFor(timeout, 0, { consecutiveTimeouts: DEAD_SERVER_TIMEOUTS, lastDelayMs: 0 });
    expect(dead.reason).toBe('dead-server');
    expect(jitteredDelay(dead, bottom)).toBe(DEAD_SERVER_MIN_MS);
    expect(jitteredDelay(dead, top)).toBe(DEAD_SERVER_MIN_MS + 30_000);
  });
});

describe('A6: Kamiden', () => {
  it('starts at upstream s 5 s, doubles per consecutive failure, caps at 5 minutes', () => {
    expect([1, 2, 3, 4, 10].map((n) => kamidenRetryDelayMs(n, 'closed', top))).toEqual([
      5_000, 10_000, 20_000, 40_000, KAMIDEN_RETRY_CAP_MS,
    ]);
    expect(kamidenRetryDelayMs(1, 'closed', bottom)).toBe(2_500);
  });

  it('RESOURCE_EXHAUSTED doubles the current backoff', () => {
    expect(kamidenRetryDelayMs(2, 'RESOURCE_EXHAUSTED: rate limit exceeded', top)).toBe(20_000);
    expect(kamidenRetryDelayMs(2, 'closed', top)).toBe(10_000);
  });
});

describe('A6: the bootstrap remembers its failures across a restart', () => {
  it('exponential from 5 s to a 10-minute cap', () => {
    expect([1, 2, 3, 8, 30].map((n) => bootstrapDelayMs(n, top))).toEqual([
      5_000, 10_000, 20_000, 600_000, BOOTSTRAP_RETRY_CAP_MS,
    ]);
  });

  it('a failure streak is written to the data dir, read back by the next process, and cleared at LIVE', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kami-lens-backoff-'));
    try {
      expect(await readBootstrapBackoff(dir)).toBeNull();
      await writeBootstrapBackoff(dir, { failures: 4, lastFailureAt: new Date().toISOString() });
      expect(await readBootstrapBackoff(dir)).toMatchObject({ failures: 4 });
      // an old streak is not a crash loop
      expect(await readBootstrapBackoff(dir, Date.now() + BOOTSTRAP_MEMORY_MS + 1)).toBeNull();
      await clearBootstrapBackoff(dir);
      expect(await fs.readdir(dir)).not.toContain(BOOTSTRAP_BACKOFF_FILE);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
