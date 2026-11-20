// 1.2.0: apply the record rule (record-rule.mts) to every committed gate
// record under docs/measurements/ — live gate records now hold aggregates
// only. Prints the files it rewrote. Idempotent.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { MEASUREMENTS_DIR, redactLocalPaths } from './lib.mts';
import { aggregatesOnly } from './record-rule.mts';

for (const f of readdirSync(MEASUREMENTS_DIR).filter((n) => n.endsWith('.json')).sort()) {
  const p = path.join(MEASUREMENTS_DIR, f);
  const text = readFileSync(p, 'utf8');
  const data = JSON.parse(text) as Record<string, unknown>;
  if (f.startsWith('pin-advance-')) continue; // a classified diff of source files, not a live record
  const next = redactLocalPaths(JSON.stringify(aggregatesOnly(data), null, 2)) + '\n';
  if (next !== text && JSON.stringify(JSON.parse(next)) !== JSON.stringify(data)) {
    writeFileSync(p, next);
    console.log(f);
  }
}
