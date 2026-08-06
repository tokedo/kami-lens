// Gate G3.a [hermetic] — JSON contract. Every mirror-backed query's output
// validates against its checked-in schema (ajv, strict); schema drift fails
// the gate. Runs over the mirror snapshot artifact; a broad sample per
// query (every kami/account/node touched by the samples). The status
// query's contract is validated on an unstarted daemon (its shape is
// state-independent); kami-stateless is validated live in G3.d.

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

async function check(query: string, args: string[], opts: { prose?: boolean; noAuthored?: boolean } = {}) {
  const envelope = await serveQuery(mirror, query, args, { ...opts, stale: false, mode: 'daemon' });
  const valid = ajv.validate(query, envelope.data);
  validated++;
  if (!valid) {
    if (failures.length < 10) failures.push({ query, args, errors: ajv.errors });
    else failures.push({ query, args, errors: 'suppressed' });
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
  await check('roster', [String(a)]);
}
// nodes: all
for (const n of nodes) await check('node', [String(n.index)]);
// items
await check('items', []);
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
// config: known fields
for (const name of ['HARVEST_EFFICACY_BOOST', 'KAMI_STANDARD_COOLDOWN']) {
  try {
    await check('config', [name]);
  } catch {
    await check('config', ['KAMI_REROLL_FEE']);
  }
}
// M4 chain-only listings (the M3-deferred trio): hermetic on the snapshot
// mirror in their no-service form — the kamiden-argument variants are
// validated live by G4.a
await check('quests', []);
// with an account, every registry row carries account-relative state and
// accepted rows carry per-objective progress (0.3.0)
for (const a of [...accountIndexes].slice(0, 3)) await check('quests', [String(a)]);
await check('trades', []);
await check('auctions', []);
// 0.2.0 chain surface: inventory / room / merchant / phase / leaderboard /
// node vitals+liquidation (killers is kamiden-backed — validated live, G6)
for (const a of [...accountIndexes].slice(0, 10)) await check('inventory', [String(a)]);
for (const r of getAllRooms(world, components).filter((room) => room.index)) {
  await check('room', [String(r.index)]);
}
const merchantsEnv = await check('merchant', []);
for (const m of (merchantsEnv.data as { merchants: { index: number }[] }).merchants) {
  await check('merchant', [String(m.index)]);
}
await check('phase', []);
for (const lbArgs of [[], ['LIQUIDATE', '1', '0'], ['TOTAL_SPENT'], ['NO_SUCH_TYPE']]) {
  await check('leaderboard', lbArgs);
}
// vitals variant on a bounded busy node (~20 occupants) + an attacker pairing
{
  const sized = [] as { index: number; count: number }[];
  for (const n of nodes) {
    const env = await serveQuery(mirror, 'node', [String(n.index)], { stale: false, mode: 'daemon' });
    sized.push({ index: n.index, count: (env.data as { harvests: unknown[] }).harvests.length });
  }
  const busy = sized
    .filter((s) => s.count > 1)
    .sort((a, b) => Math.abs(a.count - 20) - Math.abs(b.count - 20))[0];
  if (busy) {
    const vitalsEnv = await check('node', [String(busy.index), '--with-vitals']);
    const occupants = (vitalsEnv.data as { harvests: { kami: { index: number } }[] }).harvests;
    const attacker = occupants.map((h) => h.kami.index).find((i) => i > 0);
    if (attacker !== undefined) {
      await check('node', [String(busy.index), String(attacker), '--with-vitals']);
    }
  }
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
}

await writeMeasurement('g3a-json-contract', {
  snapshotBlock: cache.blockNumber,
  validated,
  kamisSampled: Math.min(300, kamiIndexes.length),
  accountsSampled: accountIndexes.size,
  nodesSampled: nodes.length,
  failures: failures.length,
  failureSamples: failures.slice(0, 10),
  match: failures.length === 0 && validated > 300,
});

if (failures.length > 0 || validated <= 300) {
  fail('G3.a', { reason: 'schema validation failures', failures: failures.slice(0, 10), validated });
}
pass('G3.a', { validated, kamis: Math.min(300, kamiIndexes.length), accounts: accountIndexes.size, nodes: nodes.length });
process.exit(0);
