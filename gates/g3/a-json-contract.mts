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
}
// nodes: all
for (const n of nodes) await check('node', [String(n.index)]);
// items
await check('items', []);
const itemsEnv = await serveQuery(mirror, 'items', [], { stale: false, mode: 'daemon' });
for (const item of (itemsEnv.data as { items: { index: number }[] }).items.slice(0, 50)) {
  await check('item', [String(item.index)]);
}
// config: known fields
for (const name of ['HARVEST_EFFICACY_BOOST', 'KAMI_STANDARD_COOLDOWN']) {
  try {
    await check('config', [name]);
  } catch {
    await check('config', ['KAMI_REROLL_FEE']);
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
