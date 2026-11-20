// 1.2.0: the documents that name the upstream pin name the CURRENT one.
// Shared by gate G5.d and test/pin-docs.test.ts. Each check is the place a
// document states "this is the pin", not every historical mention of an
// older one (those stay true as history).

import { readFileSync } from 'node:fs';
import path from 'node:path';

export type PinDocCheck = { file: string; what: string; ok: boolean };

export function checkPinDocs(root: string): { pin: string; checks: PinDocCheck[] } {
  const read = (f: string) => readFileSync(path.join(root, f), 'utf8');
  const pin = /^commit\s+([0-9a-f]{40})/m.exec(read('UPSTREAM'))![1]!;
  const short = pin.slice(0, 8);
  const spec = read('SPEC.md');
  const depRow = spec.split('\n').find((l) => l.startsWith('| **Upstream client codebase** |')) ?? '';
  const checks: PinDocCheck[] = [
    { file: 'SPEC.md', what: 'the upstream dependency row names the pin first', ok: new RegExp('^\\| \\*\\*Upstream client codebase\\*\\* \\| `Asphodel-OS/kamigotchi-open` @ `' + pin + '`').test(depRow) },
    { file: 'docs/coverage.md', what: '"currently `<pin>`"', ok: read('docs/coverage.md').includes('currently `' + short + '`') },
    { file: 'PORT_PLAN.md', what: 'the pin and its pin-advance record', ok: read('PORT_PLAN.md').includes('`' + short + '`') && read('PORT_PLAN.md').includes('pin-advance-' + short) },
    { file: 'src/abi/README.md', what: 'the JSON files\' upstream path column', ok: read('src/abi/README.md').includes('Upstream path @ `' + pin + '`') },
    { file: 'docs/string-classification.json', what: '"pin"', ok: (JSON.parse(read('docs/string-classification.json')) as { pin: string }).pin === pin },
    { file: 'README.md', what: 'the current release\'s "What changed" names the pin', ok: (() => { const r = read('README.md'); const i = r.indexOf('### What changed in'); const j = r.indexOf('### What changed in', i + 1); return i >= 0 && r.slice(i, j > 0 ? j : undefined).includes(pin); })() },
  ];
  return { pin, checks };
}
