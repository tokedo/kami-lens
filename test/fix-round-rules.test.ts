// 1.2.0: three small rules — the record path redaction, the bootstrap
// marker after a released saved world, and the pin-documents checker shown a
// wrong pin.
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, redactLocalPaths } from '../gates/g1/lib.mts';
import { checkPinDocs } from '../gates/g5/pin-docs.mts';
import { effectiveBootstrapMode } from '../src/daemon';

describe('redactLocalPaths', () => {
  it('the checkout is <repo>; below the temp or home directory only the file name is kept', () => {
    const tmp = path.join(os.tmpdir(), 'session-of-someone', 'scratch', 'base.v8snap');
    const home = path.join(os.homedir(), 'work', 'someone-dir', 'notes.json');
    const out = redactLocalPaths(JSON.stringify({ a: path.join(REPO_ROOT, 'gates', 'x.json'), b: tmp, c: home }));
    const o = JSON.parse(out) as Record<string, string>;
    expect(o.a).toBe('<repo>/gates/x.json');
    expect(o.b).toBe('<tmp>/…/base.v8snap');
    expect(o.c).toBe('<home>/…/notes.json');
    expect(out).not.toContain('someone');
  });
});

describe('status.bootstrapMode', () => {
  it('cold when a saved world was released and a whole image loaded; warm otherwise', () => {
    expect(effectiveBootstrapMode('warm', { kind: 'full' })).toBe('cold');
    expect(effectiveBootstrapMode('warm', { kind: 'delta' })).toBe('warm');
    expect(effectiveBootstrapMode('warm', null)).toBe('warm');
    expect(effectiveBootstrapMode('cold', { kind: 'full' })).toBe('cold');
    expect(effectiveBootstrapMode('unknown', { kind: 'full' })).toBe('unknown');
  });
});

describe('checkPinDocs shown a wrong pin', () => {
  it('every document check fails when UPSTREAM names another commit', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kami-lens-pindocs-'));
    try {
      for (const f of ['SPEC.md', 'PORT_PLAN.md', 'README.md', 'docs/coverage.md', 'docs/string-classification.json', 'src/abi/README.md']) {
        mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        cpSync(path.join(REPO_ROOT, f), path.join(dir, f));
      }
      const upstream = readFileSync(path.join(REPO_ROOT, 'UPSTREAM'), 'utf8').replace(/^commit\s+[0-9a-f]{40}/m, 'commit      ' + 'f'.repeat(40));
      writeFileSync(path.join(dir, 'UPSTREAM'), upstream);
      const { checks } = checkPinDocs(dir);
      expect(checks.length).toBeGreaterThan(0);
      expect(checks.filter((c) => c.ok)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
