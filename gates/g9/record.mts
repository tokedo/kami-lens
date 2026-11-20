// Gate G9's record writer (kami-lens native, not a port): the dated
// g9-prelive-stall record, through the record rule (gates/g1/record-rule.mts)
// — records hold aggregates only. `dir` is for tests.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { MEASUREMENTS_DIR, redactLocalPaths } from '../g1/lib.mts';
import { aggregatesOnly } from '../g1/record-rule.mts';

export function writeG9Record(record: Record<string, unknown>, { dir = MEASUREMENTS_DIR }: { dir?: string } = {}): string {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const out = path.join(dir, `g9-prelive-stall-${stamp}.json`);
  writeFileSync(out, redactLocalPaths(JSON.stringify(aggregatesOnly(record), null, 2)) + '\n');
  return out;
}
