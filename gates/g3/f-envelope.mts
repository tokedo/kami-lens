// Gate G3.f [hermetic] — envelope conformance. For every query, the emitted
// `untrusted` path list must equal exactly the set derivable from (the
// checked-in output schema × docs/string-classification.json), restricted
// to paths present in the data; hand-maintained divergence fails. The gate
// derives INDEPENDENTLY of src/queries/envelope.ts: its own schema walker
// and its own presence check over real query outputs. Also asserts the
// name-free mode: authored-id values absent, suppression receipts present,
// stable IDs intact.
//
// 0.4.0 adds the §3.12 enriched cases AND a PRESENCE assertion set, which
// closes a blind spot rather than adding coverage for its own sake: an
// unclassified new string resolves to authored-prose and buildEnvelope
// DELETES it, so a missing classification entry would make the field vanish
// — and a vanished field is absent from the data, hence excluded from the
// presence-filtered derivation, hence invisible to the comparison above.
// The path list below therefore asserts that each enriched field is really
// THERE in the enriched answer. A missing classification entry fails here.

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
  const data = (
    await serveQuery(mirror, 'kami', [String(idx)], { stale: false, mode: 'daemon' })
  ).data as { account?: { index: number } };
  if (data.account?.index) {
    firstKami = String(idx);
    anAccount = data.account.index;
    break;
  }
}
if (!anAccount) throw new Error('no sampled kami with an owning account');

// the sampled account's room — a real occupancy answer for the room case
const accountRoom = (
  (await serveQuery(mirror, 'account', [String(anAccount)], { stale: false, mode: 'daemon' }))
    .data as { roomIndex: number }
).roomIndex;

const CASES: {
  query: string;
  args: string[];
  opts?: { prose?: boolean; noAuthored?: boolean };
  enrich?: boolean;
}[] = [
  { query: 'kami', args: [firstKami] },
  { query: 'account', args: [String(anAccount)] },
  { query: 'account', args: [String(anAccount)], opts: { prose: true } },
  { query: 'party', args: [String(anAccount)] },
  { query: 'node', args: ['62'] },
  { query: 'item', args: ['1'] },
  { query: 'items', args: [] },
  { query: 'config', args: ['KAMI_STANDARD_COOLDOWN'] },
  // M4 chain-only listings, no-service form (kamiden variants: G4.a live)
  { query: 'quests', args: [] },
  { query: 'quests', args: [String(anAccount)] },
  { query: 'trades', args: [] },
  { query: 'auctions', args: [] },
  // 0.2.0 chain surface (killers is kamiden-backed — its envelope is
  // asserted live by G6 with this same derivation)
  { query: 'inventory', args: [String(anAccount)] },
  { query: 'room', args: [String(accountRoom)] },
  { query: 'merchant', args: [] },
  { query: 'merchant', args: ['1'] },
  { query: 'phase', args: [] },
  { query: 'leaderboard', args: [] },
  { query: 'leaderboard', args: ['LIQUIDATE', '1', '0'] },
  { query: 'node', args: ['62', '--with-vitals'] },
  { query: 'node', args: ['62', firstKami, '--with-vitals'] },
  // 0.3.0 surface: the roster is name-free BY CONSTRUCTION, so its derived
  // list must be empty in both modes — the derivation proves it rather
  // than the shape being asserted by hand
  { query: 'roster', args: [String(anAccount)] },
  { query: 'roster', args: [String(anAccount)], opts: { noAuthored: true } },
  // 0.4.0 §3.12: every query the enrichment flag touches, flag ON — the
  // derivation must still match exactly, i.e. every enriched string must be
  // classified `registry` (neither volunteered-prose nor an authored id)
  { query: 'inventory', args: [String(anAccount)], enrich: true },
  { query: 'item', args: ['1'], enrich: true },
  { query: 'items', args: [], enrich: true },
  { query: 'quests', args: [], enrich: true },
  { query: 'quests', args: [String(anAccount)], enrich: true },
  { query: 'account', args: [String(anAccount)], enrich: true },
  { query: 'account', args: [String(anAccount)], opts: { prose: true }, enrich: true },
  { query: 'node', args: ['62'], enrich: true },
  { query: 'merchant', args: ['1'], enrich: true },
  { query: 'trades', args: [], enrich: true },
  { query: 'auctions', args: [], enrich: true },
  { query: 'room', args: [String(accountRoom)], enrich: true },
  { query: 'roster', args: [String(anAccount)], enrich: true },
  { query: 'roster', args: [String(anAccount)], opts: { noAuthored: true }, enrich: true },
];

/** The §3.12 fields that MUST be present in an enriched answer. A field
 * whose classification entry is missing is deleted by the fail-safe, so its
 * absence here is exactly the bug this list exists to catch. */
const ENRICHED_PRESENCE: { query: string; args: string[]; paths: string[] }[] = [
  {
    query: 'inventory',
    args: [String(anAccount)],
    paths: ['items[].item.description'],
  },
  {
    query: 'items',
    args: [],
    paths: [
      'items[].effects.use[].type',
      'items[].effects.use[].entries[].name',
      'items[].effects.use[].entries[].description',
      'items[].requirements[].text',
      'items[].is.tradeable',
    ],
  },
  {
    // 0.5.0 (§3.13): quest REWARDS ride on the uncompacted registry rows —
    // the compact default carries no rewards at all, so the presence pair is
    // asserted against `--full`, which is where `registry[]` now lives
    query: 'quests',
    args: ['--full'],
    paths: ['registry[].rewards[].type', 'registry[].rewards[].entries[].description'],
  },
  {
    query: 'account',
    args: [String(anAccount)],
    paths: ['room.index', 'room.name', 'room.description'],
  },
  { query: 'node', args: ['62'], paths: ['room.name', 'room.description'] },
  { query: 'roster', args: [String(anAccount)], paths: ['account.room.name'] },
  {
    query: 'merchant',
    args: ['1'],
    paths: ['listings[].item.description', 'listings[].payItem.description'],
  },
  {
    // 0.5.0: skill descriptions and interpreted bonus prose are enrich-class,
    // the same rung as item descriptions
    query: 'skills',
    args: [],
    paths: ['skills[].description', 'skills[].bonuses[].type', 'skills[].bonuses[].text'],
  },
];

/** 0.5.0 (§3.13). The BASE-surface additions get the same treatment the
 * §3.12 fields got, for the same reason: an unclassified string is resolved
 * to authored-prose by the fail-safe and then DELETED from every answer,
 * silently and invisibly to a derivation-vs-emission comparison. These must
 * be present with the flag OFF — they are not enrichment. */
const BASE_PRESENCE: { query: string; args: string[]; paths: string[] }[] = [
  // the parity trio + E1
  { query: 'merchant', args: ['1'], paths: ['listings[].item.for', 'listings[].item.rarity'] },
  { query: 'inventory', args: [String(anAccount)], paths: ['items[].item.rarity'] },
  { query: 'room', args: ['1'], paths: ['exits[].toIndex', 'exits[].name'] },
  { query: 'room', args: ['5'], paths: ['exits[].gates[].type', 'exits[].gates[].text'] },
  // the leveling loop
  {
    query: 'kami',
    args: [firstKami],
    paths: ['xp', 'xpRequired', 'levelUpReady', 'skillPoints'],
  },
  {
    query: 'party',
    args: [String(anAccount)],
    paths: ['kamis[].xp', 'kamis[].xpRequired', 'kamis[].levelUpReady', 'kamis[].skillPoints'],
  },
  {
    query: 'roster',
    args: [String(anAccount)],
    paths: ['account.levelUpReady', 'account.skillPoints'],
  },
  { query: 'skills', args: [], paths: ['skillsTotal', 'skills[].name', 'skills[].max'] },
  // quests: the compact surface and the per-requirement detail
  {
    query: 'quests',
    args: [String(anAccount)],
    paths: ['view', 'questsTotal', 'quests[].index', 'quests[].requirementsMet'],
  },
  // capped listings always carry both counts
  { query: 'room', args: ['1'], paths: ['accountsTotal', 'accountsServed'] },
  { query: 'party', args: [String(anAccount)], paths: ['kamisTotal', 'kamisServed'] },
  { query: 'leaderboard', args: [], paths: ['rowsTotal', 'rowsServed'] },
  { query: 'trades', args: [], paths: ['openTotal', 'openServed'] },
  { query: 'items', args: [], paths: ['itemsTotal'] },
];

const mismatches: Record<string, unknown>[] = [];
let compared = 0;
for (const c of CASES) {
  const envelope = await serveQuery(c.enrich ? { mirror, enrich: true } : mirror, c.query, c.args, {
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

// --- §3.12 presence: the fail-safe would have deleted an unclassified field
const missingEnriched: Record<string, unknown>[] = [];
let presenceChecked = 0;
for (const c of ENRICHED_PRESENCE) {
  const enriched = await serveQuery({ mirror, enrich: true }, c.query, c.args, {
    stale: false,
    mode: 'daemon',
  });
  const bare = await serveQuery(mirror, c.query, c.args, { stale: false, mode: 'daemon' });
  for (const p of c.paths) {
    presenceChecked++;
    if (!present(enriched.data, p)) {
      missingEnriched.push({ query: c.query, args: c.args, path: p, reason: 'absent when enriched' });
    }
    // and the mirror image: the same path must NOT be there with the flag off
    if (present(bare.data, p)) {
      missingEnriched.push({ query: c.query, args: c.args, path: p, reason: 'present when flag off' });
    }
  }
}

// --- 0.5.0 base-surface presence: same fail-safe blind spot, flag OFF
const missingBase: Record<string, unknown>[] = [];
let basePresenceChecked = 0;
for (const c of BASE_PRESENCE) {
  const bare = await serveQuery(mirror, c.query, c.args, { stale: false, mode: 'daemon' });
  for (const p of c.paths) {
    basePresenceChecked++;
    if (!present(bare.data, p)) {
      missingBase.push({ query: c.query, args: c.args, path: p, reason: 'absent on the base surface' });
    }
  }
}

// --- 0.5.0: the per-requirement detail must actually name a failing
// requirement wherever the surface says requirements are unmet. A bare
// `requirementsMet: false` with nothing beside it is the defect this
// version exists to remove (§3.11), and an empty list would reinstate it.
{
  const compact = await serveQuery(mirror, 'quests', [String(anAccount)], {
    stale: false,
    mode: 'daemon',
  });
  const rows = (compact.data as {
    quests?: { index: number; requirementsMet?: boolean; unmetRequirements?: { met: boolean; text: string }[] }[];
  }).quests ?? [];
  for (const row of rows) {
    if (row.requirementsMet === false) {
      const unmet = row.unmetRequirements ?? [];
      if (unmet.length === 0) {
        missingBase.push({ query: 'quests', args: [String(anAccount)], path: `quest ${row.index}`, reason: 'requirementsMet false with no requirement named' });
      }
      if (unmet.some((r) => r.met)) {
        missingBase.push({ query: 'quests', args: [String(anAccount)], path: `quest ${row.index}`, reason: 'unmetRequirements listed a requirement that IS met' });
      }
    } else if (row.unmetRequirements !== undefined) {
      missingBase.push({ query: 'quests', args: [String(anAccount)], path: `quest ${row.index}`, reason: 'unmetRequirements present on a row whose requirements are met' });
    }
  }
}

// name-free assertions on a real party output
const named = await serveQuery(mirror, 'party', [String(anAccount)], { stale: false, mode: 'daemon' });
const nameFree = await serveQuery(mirror, 'party', [String(anAccount)], {
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
  basePresenceChecked,
  missingBase,
  nameFreeChecks,
  enrichedPresenceChecked: presenceChecked,
  enrichedPresenceProblems: missingEnriched,
  match:
    mismatches.length === 0 &&
    nameFreeOk &&
    missingEnriched.length === 0 &&
    missingBase.length === 0,
});

if (mismatches.length > 0 || !nameFreeOk || missingEnriched.length > 0 || missingBase.length > 0) {
  fail('G3.f', {
    reason:
      'envelope divergence, an enriched field that is not where it must be, or a 0.5.0 base-surface field the fail-safe would have deleted',
    mismatches,
    nameFreeChecks,
    missingEnriched,
    missingBase,
  });
}
pass('G3.f', {
  cases: compared,
  nameFreeChecks,
  enrichedPresence: presenceChecked,
  basePresence: basePresenceChecked,
});
process.exit(0);
