import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import * as clock from 'clock';

// DESIGN §3.8: projection reads an offset-corrected clock fed by stream
// blockTimestamps (uint32 seconds), never the naive wall clock.

describe('clock (§3.8)', () => {
  afterEach(() => clock.reset());

  it('equals the wall clock before any observation (upstream Date.now() mode)', () => {
    expect(clock.offset()).toBe(0);
    const wall = Date.now();
    expect(Math.abs(clock.now() - wall)).toBeLessThan(50);
  });

  it('corrects now() to the observed block time', () => {
    const blockSec = Math.floor(Date.now() / 1000) - 3600; // chain an hour "behind"
    clock.observeBlockTimestamp(blockSec);
    expect(Math.abs(clock.now() - blockSec * 1000)).toBeLessThan(50);
    expect(clock.offset()).toBeLessThan(0);
    expect(clock.lastObservedAtWallMs()).toBeGreaterThan(0);
  });

  it('re-observation supersedes the previous offset', () => {
    clock.observeBlockTimestamp(1_000_000_000);
    clock.observeBlockTimestamp(2_000_000_000);
    expect(Math.abs(clock.now() - 2_000_000_000_000)).toBeLessThan(50);
  });

  it('ignores unset/invalid proto values (no teleport to 1970)', () => {
    clock.observeBlockTimestamp(1_000_000_000);
    const offset = clock.offset();
    clock.observeBlockTimestamp(0);
    clock.observeBlockTimestamp(-5);
    clock.observeBlockTimestamp(NaN);
    expect(clock.offset()).toBe(offset);
  });

  it('reset() restores wall-clock mode', () => {
    clock.observeBlockTimestamp(1_000_000_000);
    clock.reset();
    expect(clock.offset()).toBe(0);
  });
});

// Static tripwire for pin advances: no wall-clock read may exist in the
// projection trees — every one must route through clock.now() (§3.8). A new
// upstream Date.now()/new Date()/moment() landing there on a pin advance
// fails this test until it is wired to the clock.
describe('projection trees carry no naive wall-clock reads', () => {
  const ROOT = path.resolve(__dirname, '../src');
  const TREES = ['app/cache', 'network/shapes', 'constants', 'assets'];
  const EXTRA_FILES = ['utils/time.ts'];
  const WALL_CLOCK = /\bDate\.now\(\)|\bnew Date\(\)|(?<![\w.])moment\(\)/;

  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e)) files.push(p);
    }
  };
  TREES.forEach((t) => walk(path.join(ROOT, t)));
  EXTRA_FILES.forEach((f) => files.push(path.join(ROOT, f)));

  it('scans a non-trivial file set', () => {
    expect(files.length).toBeGreaterThan(250);
  });

  it.each(files.map((f) => [path.relative(ROOT, f), f]))('%s', (_rel, file) => {
    const code = stripComments(readFileSync(file as string, 'utf8'));
    expect(code).not.toMatch(WALL_CLOCK);
  });
});
