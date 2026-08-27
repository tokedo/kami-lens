// Gate G3.a [hermetic] — JSON contract. Every mirror-backed query's output
// validates against its checked-in schema (ajv, strict); schema drift fails
// the gate. Runs over the mirror snapshot artifact; a broad sample per
// query (every kami/account/node touched by the samples). The status
// query's contract is validated on an unstarted daemon (its shape is
// state-independent); kami-stateless is validated live in G3.d.
//
// 0.4.0: every query the §3.12 enrichment flag touches is validated in BOTH
// modes against the SAME schema — the enriched fields are optional, so a
// flag-off answer and a flag-on answer are both legal instances (the
// account/--prose pattern). The flag-off answers additionally carry a
// tripwire: no `effects` key, no `entries`-shaped allo row and no
// `text`-shaped requirement row may appear anywhere in them. That is a
// coarse check by design — G3.g proves flag-off identity exactly, leaf by
// leaf, against a 0.3.0 baseline.

import Ajv from 'ajv/dist/2020';

import { resolveConfig } from '../../src/config';
import { KamiLensDaemon } from '../../src/daemon';
import { buildEnvelope, serveQuery } from '../../src/queries';
import { loadSchema, QUERY_NAMES } from '../../src/queries/registry';
import { buildStatusData } from '../../src/server';
import { query as queryKamis } from '../../src/network/shapes/Kami/queries';
import { getAllNodes } from '../../src/network/shapes/Node';
import { getAllRooms } from '../../src/network/shapes/Room';
import { getKamiIndex } from '../../src/network/shapes/utils/component';
import {
  ARTIFACTS_DIR,
  fail,
  loadCacheFromSnapshotFile,
  pass,
  writeMeasurement,
} from '../g1/lib.mts';
import { buildMirror } from '../g2/lib.mts';
import path from 'node:path';

const config = resolveConfig();
const cache = await loadCacheFromSnapshotFile(path.join(ARTIFACTS_DIR, 'c2.v8snap'), config);
const { world, components } = buildMirror(cache);
const mirror = { world, components, blockNumber: cache.blockNumber };

const ajv = new Ajv({ strict: true, allErrors: true });
for (const name of [...QUERY_NAMES, 'status', 'kami-stateless'] as const) {
  ajv.addSchema(loadSchema(name as never), name);
}

const kamiEntities = queryKamis(components);
const kamiIndexes = kamiEntities.slice(0, 500).map((e) => getKamiIndex(components, e));
const nodes = getAllNodes(world, components).filter((n) => n.index);

type Failure = { query: string; args: unknown; errors: unknown };
const failures: Failure[] = [];
let validated = 0;
let enrichedValidated = 0;

/** §3.12 tripwire: shapes that exist ONLY under the enrichment flag. */
function enrichmentHits(value: unknown, at = '', hits: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((v, i) => enrichmentHits(v, `${at}[${i}]`, hits));
    return hits;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.includes('effects')) hits.push(`${at}.effects`);
    if (keys.includes('entries') && keys.includes('type') && keys.includes('value')) {
      hits.push(`${at} (AlloOut)`);
    }
    // 0.5.0: the {type,index,value,text} projection is no longer
    // enrich-only — room EXIT GATES serve it on the base surface (§3.13).
    // Narrowed twice over: an enrich ItemRequirement carries `value` and no
    // per-condition status, and a gate row lives under `.gates[`.
    if (
      keys.includes('text') &&
      keys.includes('type') &&
      keys.includes('index') &&
      keys.includes('value') &&
      !keys.includes('met') &&
      !at.includes('.gates[')
    ) {
      hits.push(`${at} (ItemRequirement)`);
    }
    for (const [k, v] of Object.entries(obj)) enrichmentHits(v, at ? `${at}.${k}` : k, hits);
    return hits;
  }
  return hits;
}
const flagOffEnrichmentHits: Record<string, string[]> = {};

async function check(query: string, args: string[], opts: { prose?: boolean; noAuthored?: boolean } = {}) {
  const envelope = await serveQuery(mirror, query, args, { ...opts, stale: false, mode: 'daemon' });
  const valid = ajv.validate(query, envelope.data);
  validated++;
  if (!valid) {
    if (failures.length < 10) failures.push({ query, args, errors: ajv.errors });
    else failures.push({ query, args, errors: 'suppressed' });
  }
  const hits = enrichmentHits(envelope.data);
  if (hits.length > 0) flagOffEnrichmentHits[`${query} ${args.join(' ')}`] = hits.slice(0, 5);
  return envelope;
}

/** The same query, same schema, with the daemon-level enrichment flag on. */
async function checkEnriched(
  query: string,
  args: string[],
  opts: { prose?: boolean; noAuthored?: boolean } = {}
) {
  const envelope = await serveQuery({ mirror, enrich: true }, query, args, {
    ...opts,
    stale: false,
    mode: 'daemon',
  });
  const valid = ajv.validate(query, envelope.data);
  validated++;
  enrichedValidated++;
  if (!valid) {
    if (failures.length < 10) {
      failures.push({ query: `${query} [enrich]`, args, errors: ajv.errors });
    } else failures.push({ query: `${query} [enrich]`, args, errors: 'suppressed' });
  }
  return envelope;
}

// kami: broad sample
for (const index of kamiIndexes.filter((i) => i > 0).slice(0, 300)) await check('kami', [String(index)]);
// accounts: via kami owners (first 40 distinct)
const accountIndexes = new Set<number>();
for (const index of kamiIndexes.filter((i) => i > 0)) {
  if (accountIndexes.size >= 40) break;
  const env = await serveQuery(mirror, 'kami', [String(index)], { stale: false, mode: 'daemon' });
  const acc = (env.data as { account?: { index: number } }).account;
  if (acc?.index) accountIndexes.add(acc.index);
}
// Canonical (default-mode) outputs are what the schemas describe — the
// name-free variant withholds required name fields BY CONTRACT (receipted;
// G3.f asserts that shape), so it is not validated against the canonical
// schema here.
for (const a of accountIndexes) {
  await check('account', [String(a)]);
  await check('account', [String(a)], { prose: true });
  await check('party', [String(a)]);
  await check('party', [String(a), '--full']);
  await check('roster', [String(a)]);
}
// nodes: all, both modes
for (const n of nodes) {
  await check('node', [String(n.index)]);
  await check('node', [String(n.index), '--full']);
}
// items — compact default, a type filter, and the uncompacted form (§3.13)
await check('items', []);
await check('items', ['--full']);
for (const type of ['FOOD', 'MATERIAL', 'NO_SUCH_TYPE']) await check('items', [type]);
// skills (0.5.0): the registry, and a kami's own investments
await check('skills', []);
for (const index of kamiIndexes.filter((i) => i > 0).slice(0, 20)) {
  await check('skills', [String(index)]);
}
const itemsEnv = await serveQuery(mirror, 'items', [], { stale: false, mode: 'daemon' });
for (const item of (itemsEnv.data as { items: { index: number }[] }).items.slice(0, 50)) {
  await check('item', [String(item.index)]);
}
// pool enrichment (0.3.0): every item that trades in a pool, so the
// enriched single-item answer is validated and not only the bare one
const pooledIndexes = new Set<number>(
  (itemsEnv.data as { pools?: { items: number[] }[] }).pools?.flatMap((p) => p.items) ?? []
);
for (const index of pooledIndexes) await check('item', [String(index)]);
// config: real fields only, both forms (§3.14)
//
// NOTE, and it is the whole point of the 0.5.0 config change: this block used
// to fall back to 'KAMI_REROLL_FEE', a key this world does not define. It
// "passed" because the query answered `{value: 0}` for it — the gate was
// itself reading a nonexistent field as a settled zero, exactly the way an
// agent did for twenty sessions. It now fails loudly, so the gate asks for
// keys that exist and asserts the refusal separately.
for (const name of ['KAMI_STANDARD_COOLDOWN', 'KAMI_HARV_INTENSITY', 'KAMI_TREE_REQ']) {
  await check('config', [name]);
  await check('config', [name, '--array']);
}
// …and a name the world does not hold must REFUSE, on both forms, rather
// than confirm itself
for (const args of [
  ['DEFINITELY_NOT_A_CONFIG_KEY'],
  ['DEFINITELY_NOT_A_CONFIG_KEY', '--array'],
  ['POOL_ENABLED'],
]) {
  let refused = false;
  try {
    await serveQuery(mirror, 'config', args, { stale: false, mode: 'daemon' });
  } catch (e) {
    refused = (e as { code?: string }).code === 'NOT_FOUND';
  }
  validated++;
  if (!refused) {
    failures.push({ query: 'config', args, errors: 'a nonexistent config field did not answer NOT_FOUND' });
  }
}
// M4 chain-only listings (the M3-deferred trio): hermetic on the snapshot
// mirror in their no-service form — the kamiden-argument variants are
// validated live by G4.a
await check('quests', []);
await check('quests', ['--full']);
// with an account, every registry row carries account-relative state and
// accepted rows carry per-objective progress (0.3.0)
for (const a of [...accountIndexes].slice(0, 3)) {
  // 0.5.0 (§3.13): four account-relative forms, one schema. The compact
  // default, the two narrowed views, the keyed single-quest detail, and the
  // uncompacted --full shape must ALL be legal instances.
  const compact = await check('quests', [String(a)]);
  await check('quests', [String(a), '--open']);
  await check('quests', [String(a), '--accepted']);
  await check('quests', [String(a), '--full']);
  const rows = (compact.data as { quests?: { index: number }[] }).quests ?? [];
  for (const row of rows.slice(0, 5)) await check('quests', [String(a), String(row.index)]);
}
await check('trades', []);
await check('trades', ['--full']);
await check('auctions', []);
// 0.2.0 chain surface: inventory / room / merchant / phase / leaderboard /
// node vitals+liquidation (killers is kamiden-backed — validated live, G6)
for (const a of [...accountIndexes].slice(0, 10)) await check('inventory', [String(a)]);
for (const r of getAllRooms(world, components).filter((room) => room.index)) {
  await check('room', [String(r.index)]);
  await check('room', [String(r.index), '--full']);
}
const merchantsEnv = await check('merchant', []);
for (const m of (merchantsEnv.data as { merchants: { index: number }[] }).merchants) {
  await check('merchant', [String(m.index)]);
  await check('merchant', [String(m.index), '--full']);
}
await check('phase', []);
for (const lbArgs of [
  [],
  ['--full'],
  ['LIQUIDATE', '1', '0'],
  ['LIQUIDATE', '1', '0', '--full'],
  ['TOTAL_SPENT'],
  ['NO_SUCH_TYPE'],
]) {
  await check('leaderboard', lbArgs);
}
// vitals variant on a bounded busy node (~20 occupants) + an attacker pairing
{
  const sized = [] as { index: number; count: number }[];
  for (const n of nodes) {
    const env = await serveQuery(mirror, 'node', [String(n.index)], { stale: false, mode: 'daemon' });
    sized.push({
      index: n.index,
      count: (env.data as { harvestsTotal: number }).harvestsTotal,
    });
  }
  const busy = sized
    .filter((s) => s.count > 1)
    .sort((a, b) => Math.abs(a.count - 20) - Math.abs(b.count - 20))[0];
  if (busy) {
    const vitalsEnv = await check('node', [String(busy.index), '--with-vitals']);
    await check('node', [String(busy.index), '--with-vitals', '--full']);
    const occupants = (vitalsEnv.data as { harvests: { kami: { index: number } }[] }).harvests;
    const attacker = occupants.map((h) => h.kami.index).find((i) => i > 0);
    if (attacker !== undefined) {
      await check('node', [String(busy.index), String(attacker), '--with-vitals']);
      await check('node', [String(busy.index), String(attacker), '--with-vitals', '--full']);
    }
  }
}
// --- §3.12 enriched mode: the same schemas, the flag on -------------------
{
  const accs = [...accountIndexes].slice(0, 5);
  for (const a of accs) {
    await checkEnriched('inventory', [String(a)]);
    await checkEnriched('account', [String(a)]);
    await checkEnriched('account', [String(a)], { prose: true });
    await checkEnriched('roster', [String(a)]);
    await checkEnriched('roster', [String(a)], { noAuthored: true });
    await checkEnriched('quests', [String(a)]);
    await checkEnriched('quests', [String(a), '--open']);
    await checkEnriched('quests', [String(a), '--accepted']);
    await checkEnriched('quests', [String(a), '--full']);
    await checkEnriched('quests', [String(a), '1']);
  }
  await checkEnriched('quests', []);
  await checkEnriched('items', []);
  await checkEnriched('items', ['--full']);
  // 0.5.0: skill descriptions and bonus prose are enrich-class, the same rung
  // as item descriptions — both forms of the query validate either way
  await checkEnriched('skills', []);
  for (const index of kamiIndexes.filter((i) => i > 0).slice(0, 10)) {
    await checkEnriched('skills', [String(index)]);
  }
  for (const item of (itemsEnv.data as { items: { index: number }[] }).items.slice(0, 50)) {
    await checkEnriched('item', [String(item.index)]);
  }
  for (const index of pooledIndexes) await checkEnriched('item', [String(index)]);
  await checkEnriched('trades', []);
  await checkEnriched('auctions', []);
  const merchants = await checkEnriched('merchant', []);
  for (const m of (merchants.data as { merchants: { index: number }[] }).merchants) {
    await checkEnriched('merchant', [String(m.index)]);
  }
  for (const n of nodes.slice(0, 20)) await checkEnriched('node', [String(n.index)]);
  for (const r of getAllRooms(world, components)
    .filter((room) => room.index)
    .slice(0, 20)) {
    await checkEnriched('room', [String(r.index)]);
    await checkEnriched('room', [String(r.index), '--full']);
  }
  await checkEnriched('party', [String([...accountIndexes][0])]);
  await checkEnriched('leaderboard', ['--full']);
}

// status: contract on an unstarted daemon
{
  const daemon = new KamiLensDaemon({ dataDir: path.join(ARTIFACTS_DIR, 'g3a-void') });
  const envelope = buildEnvelope(
    buildStatusData(daemon),
    loadSchema('status'),
    { blockNumber: 0, stale: true, mode: 'daemon' },
    {}
  );
  validated++;
  if (!ajv.validate('status', envelope.data)) failures.push({ query: 'status', args: [], errors: ajv.errors });

  // §3.15 (0.5.1): the SAME contract with a head sample present. The head
  // read is passed in rather than performed inside buildStatusData precisely
  // so this gate (and G3.g, and G5.c) stay hermetic — which means the three
  // fields it adds would otherwise never be schema-checked anywhere. A
  // SYNTHETIC sample covers them without a network read.
  const withHead = buildStatusData(daemon, {
    blockNumber: 32_600_000,
    sampledAt: '2026-08-26T00:00:00.000Z',
  });
  const headEnvelope = buildEnvelope(
    withHead,
    loadSchema('status'),
    { blockNumber: 0, stale: true, mode: 'daemon' },
    {}
  );
  validated++;
  if (!ajv.validate('status', headEnvelope.data)) {
    failures.push({ query: 'status+head', args: [], errors: ajv.errors });
  }
  // and the three fields travel TOGETHER, always: an answer carrying a lag
  // without the head it was computed from is not auditable, and one carrying
  // a head with no timestamp is a number of unknown age (§3.14).
  const d = headEnvelope.data as Record<string, unknown>;
  const present = ['blockLag', 'headBlockNumber', 'headSampledAt'].filter((k) => k in d);
  if (present.length !== 3) {
    failures.push({ query: 'status+head', args: [], errors: [{ message: `head fields must appear together; got ${present.join(',')}` }] });
  }
  if (d.blockLag !== Math.max(0, 32_600_000 - (d.liveBlockNumber as number))) {
    failures.push({ query: 'status+head', args: [], errors: [{ message: 'blockLag is not head minus liveBlockNumber' }] });
  }
  // the flag-off shape must add none of them — this is what keeps G3.g's
  // frozen status baseline valid without a re-capture
  const bare = envelope.data as Record<string, unknown>;
  const leaked = ['blockLag', 'headBlockNumber', 'headSampledAt'].filter((k) => k in bare);
  if (leaked.length > 0) {
    failures.push({ query: 'status', args: [], errors: [{ message: `status without a head sample must omit ${leaked.join(',')}` }] });
  }
}

const flagOffLeaks = Object.keys(flagOffEnrichmentHits).length;

await writeMeasurement('g3a-json-contract', {
  snapshotBlock: cache.blockNumber,
  validated,
  enrichedValidated,
  kamisSampled: Math.min(300, kamiIndexes.length),
  accountsSampled: accountIndexes.size,
  nodesSampled: nodes.length,
  failures: failures.length,
  failureSamples: failures.slice(0, 10),
  flagOffEnrichmentHits,
  match: failures.length === 0 && validated > 300 && enrichedValidated > 50 && flagOffLeaks === 0,
});

if (failures.length > 0 || validated <= 300 || enrichedValidated <= 50 || flagOffLeaks > 0) {
  fail('G3.a', {
    reason: 'schema validation failures or enrichment leaked into a flag-off answer',
    failures: failures.slice(0, 10),
    validated,
    enrichedValidated,
    flagOffEnrichmentHits,
  });
}
pass('G3.a', {
  validated,
  enriched: enrichedValidated,
  kamis: Math.min(300, kamiIndexes.length),
  accounts: accountIndexes.size,
  nodes: nodes.length,
});
process.exit(0);
