// 1.2.1: the hand-captured display-parity transcription is not part of the
// public tree. Gates G2.b and G3.c look it up at one path (or the path an
// environment variable names), SKIP with a clear line and exit 2 — the
// gates' "not runnable here" — when it is absent, and read it as before when
// a local copy is present. The gate runners go on past a skipped part.
// Synthetic files only: no observation of any account is written here.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_OBSERVATIONS,
  OBSERVATIONS_ENV,
  excludedKamiIndexes,
  locateObservations,
} from '../gates/g2/observations.mts';

const REPO = path.resolve(import.meta.dirname, '..');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'g2b-obs-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ABSENT = path.join(tmp, 'absent.json');
const BAD_JSON = path.join(tmp, 'not-json.json');
writeFileSync(BAD_JSON, '{ this is not json');
const WRONG_SCHEMA = path.join(tmp, 'wrong-schema.json');
writeFileSync(WRONG_SCHEMA, JSON.stringify({ schema: 'synthetic-test-schema', screenshots: [] }));

const BAD_EXCLUDED = path.join(tmp, 'bad-excluded.json');
writeFileSync(BAD_EXCLUDED, JSON.stringify({ schema: 'g2b-screenshot-transcription-v2', excludedKamiIndexes: ['x'], screenshots: [] }));

function gate(script: string, observations: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: '1' };
  delete env[OBSERVATIONS_ENV];
  if (observations !== undefined) env[OBSERVATIONS_ENV] = observations;
  const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(REPO, script)], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 90_000,
    env,
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe('the display-parity transcription is looked up, never assumed (1.2.1)', () => {
  it('the default path is gates/fixtures/g2b-observations.json, and the public tree ignores it', () => {
    expect(path.relative(REPO, DEFAULT_OBSERVATIONS)).toBe(path.join('gates', 'fixtures', 'g2b-observations.json'));
    const r = spawnSync('git', ['check-ignore', '-q', 'gates/fixtures/g2b-observations.json'], { cwd: REPO });
    expect(r.status).toBe(0);
  });

  it(`${OBSERVATIONS_ENV} overrides the path; absent → not present, present → present`, () => {
    expect(locateObservations({})).toEqual({
      path: DEFAULT_OBSERVATIONS,
      source: 'default',
      present: expect.any(Boolean),
    });
    expect(locateObservations({ [OBSERVATIONS_ENV]: ABSENT })).toEqual({
      path: ABSENT,
      source: OBSERVATIONS_ENV,
      present: false,
    });
    expect(locateObservations({ [OBSERVATIONS_ENV]: WRONG_SCHEMA })).toEqual({
      path: WRONG_SCHEMA,
      source: OBSERVATIONS_ENV,
      present: true,
    });
  });
});

describe('G2.b and G3.c skip cleanly when it is absent, and read it when present (1.2.1)', () => {
  it('G2.b absent: SKIP line naming the path and the override, exit 2', () => {
    const r = gate('gates/g2/b-display-parity.mts', ABSENT);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/^SKIP G2\.b /m);
    expect(r.out).toContain(ABSENT);
    expect(r.out).toContain(OBSERVATIONS_ENV);
    expect(r.out).not.toMatch(/^FAIL /m);
  });

  it('G2.b present: the file at the override path is read (a wrong schema is refused, exit 1)', () => {
    const r = gate('gates/g2/b-display-parity.mts', WRONG_SCHEMA);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('unexpected fixture schema');
    expect(r.out).toContain('synthetic-test-schema');
  });

  it('G3.c absent: SKIP line naming the path and the override, exit 2', () => {
    const r = gate('gates/g3/c-party-parity.mts', ABSENT);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/^SKIP G3\.c /m);
    expect(r.out).toContain(ABSENT);
    expect(r.out).toContain(OBSERVATIONS_ENV);
    expect(r.out).not.toMatch(/^FAIL /m);
  });

  it('G3.c present: the file at the override path is read (unparsable JSON fails, exit 1)', () => {
    const r = gate('gates/g3/c-party-parity.mts', BAD_JSON);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/JSON/);
  });
});

describe('the SKIP line names no local home (1.2.1)', () => {
  // Only the DEFAULT path is printed repo-relative. An override OUTSIDE the
  // repo is printed as given — the operator chose that path.
  it.skipIf(existsSync(DEFAULT_OBSERVATIONS))('default path, file absent: lookedUpAt is repo-relative; no absolute repo path or home dir in the line', () => {
    const r = gate('gates/g3/c-party-parity.mts', undefined);
    expect(r.status, r.out).toBe(2);
    const line = r.out.split('\n').find((l) => l.startsWith('SKIP G3.c '))!;
    expect(line).toBeDefined();
    const detail = JSON.parse(line.slice('SKIP G3.c '.length)) as { lookedUpAt: string; source: string };
    expect(detail.source).toBe('default');
    expect(detail.lookedUpAt).toBe('gates/fixtures/g2b-observations.json');
    expect(line).not.toContain(REPO);
    expect(line).not.toContain(os.homedir());
  });
});

describe('the kamis the observer controls come from the transcription, never the source (1.2.1)', () => {
  it('field present → exactly those indices are excluded', () => {
    const set = excludedKamiIndexes({ excludedKamiIndexes: [701, 702] });
    expect([...set].sort()).toEqual([701, 702]);
    expect(set.has(704)).toBe(false);
  });

  it('field absent → none excluded', () => {
    expect(excludedKamiIndexes({ screenshots: [] }).size).toBe(0);
    expect(excludedKamiIndexes({}).size).toBe(0);
  });

  it('anything but an array of non-negative integers is refused', () => {
    expect(() => excludedKamiIndexes({ excludedKamiIndexes: ['x'] })).toThrow(/excludedKamiIndexes/);
    expect(() => excludedKamiIndexes({ excludedKamiIndexes: 701 })).toThrow(/excludedKamiIndexes/);
    expect(() => excludedKamiIndexes({ excludedKamiIndexes: [1.5] })).toThrow(/excludedKamiIndexes/);
    expect(() => excludedKamiIndexes({ excludedKamiIndexes: [-1] })).toThrow(/excludedKamiIndexes/);
  });

  it('G2.b reads the field from the transcription it loads (a malformed field fails, exit 1)', () => {
    const r = gate('gates/g2/b-display-parity.mts', BAD_EXCLUDED);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('excludedKamiIndexes must be an array');
  });

  it('no gate source hard-codes the exclusion list', () => {
    const g = spawnSync('grep', ['-nE', 'EXCLUDED_KAMI_INDEXES = new Set\\(\\[[0-9]', 'gates/g2/b-display-parity.mts'], { cwd: REPO });
    expect(g.status).toBe(1);
  });
});

describe('a gate runner goes on past a part that is not runnable here (1.2.1)', () => {
  const run = (body: string) =>
    spawnSync('bash', ['-c', `set -euo pipefail; source gates/lib.sh; ${body}`], { cwd: REPO, encoding: 'utf8' });

  it('exit 2 → a SKIP line and the next part runs; the summary names the skipped part', () => {
    const r = run(`skippable G9.z bash -c 'exit 2'; echo NEXT-PART-RAN; summary G9`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^SKIP G9\.z /m);
    expect(r.stdout).toContain('NEXT-PART-RAN');
    expect(r.stdout).toMatch(/G9 PASS .*skipped: G9\.z/);
  });

  it('exit 0 runs on with nothing skipped; exit 1 still stops the gate with that code', () => {
    const ok = run(`skippable G9.y true; echo NEXT-PART-RAN; summary G9`);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('NEXT-PART-RAN');
    expect(ok.stdout).not.toMatch(/skipped/);
    const bad = run(`skippable G9.x bash -c 'exit 1'; echo NEXT-PART-RAN`);
    expect(bad.status).toBe(1);
    expect(bad.stdout).not.toContain('NEXT-PART-RAN');
  });

  it('g2.sh runs G2.b, and g3.sh runs G3.c, through the skip-aware runner', () => {
    const g2 = spawnSync('grep', ['-E', '^skippable G2\\.b .*gates/g2/b-display-parity\\.mts', 'gates/g2.sh'], { cwd: REPO });
    const g3 = spawnSync('grep', ['-E', '^skippable G3\\.c .*gates/g3/c-party-parity\\.mts', 'gates/g3.sh'], { cwd: REPO });
    expect(g2.status).toBe(0);
    expect(g3.status).toBe(0);
  });
});
