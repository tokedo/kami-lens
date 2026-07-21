// Gate G3.f [hermetic] — envelope conformance. For every query, the emitted
// `untrusted` path list must equal exactly the set derivable from (the
// checked-in output schema × docs/string-classification.json), restricted
// to paths present in the data; hand-maintained divergence fails. The gate
// derives INDEPENDENTLY of src/queries/envelope.ts: its own schema walker
// and its own presence check over real query outputs. Also asserts the
// name-free mode: authored-id values absent, suppression receipts present,
// stable IDs intact.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveConfig } from '../../src/config';
import { serveQuery } from '../../src/queries';
import { loadSchema } from '../../src/queries/registry';
import { query as queryKamis } from '../../src/network/shapes/Kami/queries';
import { getKamiIndex } from '../../src/network/shapes/utils/component';
import {
  ARTIFACTS_DIR,
  REPO_ROOT,
  fail,
  loadCacheFromSnapshotFile,
  pass,
  writeMeasurement,
} from '../g1/lib.mts';
import { buildMirror } from '../g2/lib.mts';

// --- independent derivation --------------------------------------------------
type Cls = { default: string; types: Record<string, Record<string, string>> };
const cls = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'docs', 'string-classification.json'), 'utf8')
) as Cls;

type Node = {
  type?: string;
  properties?: Record<string, Node>;
  items?: Node;
  $ref?: string;
};

function deriveAuthoredPaths(schema: { $defs?: Record<string, Node> } & Node): string[] {
  const defs = schema.$defs ?? {};
  const authored: string[] = [];
  const visit = (raw: Node, at: string, owner?: string): void => {
    let node = raw;
    let ownerName = owner;
    if (raw.$ref) {
      const name = raw.$ref.replace('#/$defs/', '');
      node = defs[name];
      ownerName = name;
    }
    if (node.type === 'string') {
      const leaf = (at.split('.').pop() ?? '').replace(/\[\]$/, '');
      const klass = (ownerName && cls.types[ownerName]?.[leaf]) || cls.default;
      if (klass === 'authored-id' || klass === 'authored-prose') authored.push(at);
      return;
    }
    if (node.type === 'object' && node.properties) {
      for (const [k, child] of Object.entries(node.properties)) {
        visit(child, at ? `${at}.${k}` : k, ownerName);
      }
    }
    if (node.type === 'array' && node.items) visit(node.items, `${at}[]`, ownerName);
  };
  visit(schema, '');
  return authored;
}

function present(data: unknown, pathExpr: string): boolean {
  let frontier: unknown[] = [data];
  for (const seg of pathExpr.split('.')) {
    const isArr = seg.endsWith('[]');
    const key = isArr ? seg.slice(0, -2) : seg;
    const next: unknown[] = [];
    for (const v of frontier) {
      if (v == null || typeof v !== 'object') continue;
      const child = (v as Record<string, unknown>)[key];
      if (child === undefined) continue;
      if (isArr) next.push(...(Array.isArray(child) ? child : []));
      else next.push(child);
    }
    frontier = next;
  }
  return frontier.some((v) => v != null);
}

function collectValues(data: unknown, pathExpr: string): unknown[] {
  let frontier: unknown[] = [data];
  for (const seg of pathExpr.split('.')) {
    const isArr = seg.endsWith('[]');
    const key = isArr ? seg.slice(0, -2) : seg;
    const next: unknown[] = [];
    for (const v of frontier) {
      if (v == null || typeof v !== 'object') continue;
      const child = (v as Record<string, unknown>)[key];
      if (child === undefined) continue;
      if (isArr) next.push(...(Array.isArray(child) ? child : []));
      else next.push(child);
    }
    frontier = next;
  }
  return frontier;
}

// --- run real queries and compare -------------------------------------------
const config = resolveConfig();
const cache = await loadCacheFromSnapshotFile(path.join(ARTIFACTS_DIR, 'c2.v8snap'), config);
const { world, components } = buildMirror(cache);
const mirror = { world, components, blockNumber: cache.blockNumber };

const kamiIndexes = queryKamis(components)
  .slice(0, 50)
  .map((e) => getKamiIndex(components, e))
  .filter((i) => i > 0);
// first sampled kami that has an owning account (externals have none)
let firstKami = '';
let anAccount = 0;
for (const idx of kamiIndexes) {
  const data = serveQuery(mirror, 'kami', [String(idx)], { stale: false, mode: 'daemon' })
    .data as { account?: { index: number } };
  if (data.account?.index) {
    firstKami = String(idx);
    anAccount = data.account.index;
    break;
  }
}
if (!anAccount) throw new Error('no sampled kami with an owning account');

const CASES: { query: string; args: string[]; opts?: { prose?: boolean; noAuthored?: boolean } }[] = [
  { query: 'kami', args: [firstKami] },
  { query: 'account', args: [String(anAccount)] },
  { query: 'account', args: [String(anAccount)], opts: { prose: true } },
  { query: 'party', args: [String(anAccount)] },
  { query: 'node', args: ['62'] },
  { query: 'item', args: ['1'] },
  { query: 'items', args: [] },
  { query: 'config', args: ['KAMI_STANDARD_COOLDOWN'] },
];

const mismatches: Record<string, unknown>[] = [];
let compared = 0;
for (const c of CASES) {
  const envelope = serveQuery(mirror, c.query, c.args, {
    ...c.opts,
    stale: false,
    mode: 'daemon',
  });
  const derived = deriveAuthoredPaths(loadSchema(c.query as never) as never)
    .filter((p) => present(envelope.data, p))
    .sort();
  compared++;
  if (JSON.stringify(derived) !== JSON.stringify(envelope.untrusted)) {
    mismatches.push({ ...c, derived, emitted: envelope.untrusted });
  }
}

// name-free assertions on a real party output
const named = serveQuery(mirror, 'party', [String(anAccount)], { stale: false, mode: 'daemon' });
const nameFree = serveQuery(mirror, 'party', [String(anAccount)], {
  noAuthored: true,
  stale: false,
  mode: 'daemon',
});
const nameFreeChecks = {
  authoredAbsent:
    collectValues(nameFree.data, 'account.name').length === 0 &&
    collectValues(nameFree.data, 'kamis[].name').length === 0,
  receiptsPresent:
    (nameFree.meta.suppressed ?? []).includes('account.name') &&
    (nameFree.meta.suppressed ?? []).includes('kamis[].name'),
  stableIdsIntact:
    JSON.stringify(collectValues(nameFree.data, 'kamis[].id')) ===
    JSON.stringify(collectValues(named.data, 'kamis[].id')),
  untrustedEmpty: nameFree.untrusted.length === 0,
};
const nameFreeOk = Object.values(nameFreeChecks).every(Boolean);

await writeMeasurement('g3f-envelope', {
  snapshotBlock: cache.blockNumber,
  cases: compared,
  mismatches,
  nameFreeChecks,
  match: mismatches.length === 0 && nameFreeOk,
});

if (mismatches.length > 0 || !nameFreeOk) {
  fail('G3.f', { reason: 'envelope divergence', mismatches, nameFreeChecks });
}
pass('G3.f', { cases: compared, nameFreeChecks });
process.exit(0);
