// 1.2.0: the daemon's code never reaches into the gates or the tests.
//
// gates/g1/fixture-deploy.mts writes K = 1000 into a FROZEN gate fixture that
// predates the multiplier's deploy. On a live mirror that would be an
// invented K — exactly what the daemon refuses to serve. Nothing under src/
// may import gate or test code (eslint's no-restricted-imports says the same
// for src/**); this test fails on any such import, however it is spelled.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(p) ? [p] : [];
  });

const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

describe('1.2.0: src/ never imports gate or test code', () => {
  it('no import specifier in src/ resolves into gates/ or test/, or names the fixture injection', () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(SPEC)) {
        const spec = m[1]!;
        const resolved = spec.startsWith('.') ? path.resolve(path.dirname(f), spec) : path.join(ROOT, spec);
        const rel = path.relative(ROOT, resolved).split(path.sep);
        if (rel[0] === 'gates' || rel[0] === 'test' || /fixture-deploy/.test(spec)) {
          offenders.push(`${path.relative(ROOT, f)} -> ${spec}`);
        }
      }
      if (/withHarvestMultiplierDeploy/.test(text)) offenders.push(`${path.relative(ROOT, f)} names withHarvestMultiplierDeploy`);
    }
    expect(offenders).toEqual([]);
  });
});
