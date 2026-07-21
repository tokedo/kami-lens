// Gate G3.d [live] — stateless equivalence. With the daemon stopped,
// `kami-lens kami <index> --stateless` must equal the daemon's answer for
// the same kami at the same block (vitals only — the stateless-computable
// discrete subset: id, index, name, state, level, hp.total); discovery
// queries in stateless mode must exit with the documented REQUIRES_DAEMON
// code (5), not a wrong answer.
//
// Mechanics: warm-start the daemon (overnight data dir), reach LIVE, take
// kami answers over the query socket at the daemon's block B, stop the
// daemon, then run the stateless path pinned to B immediately (the public
// RPC serves eth_call state only ~50–120 blocks deep). The CLI itself is
// exercised once for the stateless envelope + exit code and once for the
// discovery-refusal code.

import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import path from 'node:path';

import Ajv from 'ajv/dist/2020';

import { resolveConfig } from '../../src/config';
import { loadSchema } from '../../src/queries/registry';
import { statelessKami } from '../../src/stateless';
import { ARTIFACTS_DIR, REPO_ROOT, fail, pass, sleep, writeMeasurement } from '../g1/lib.mts';

const DATA_DIR = path.join(ARTIFACTS_DIR, 'overnight-data');
const SOCK = path.join(DATA_DIR, 'kami-lens.sock');
const KAMI_INDEXES = [10016, 10164, 11279];

// --- 1. daemon up (warm) -----------------------------------------------------
const daemon = spawn('npx', ['tsx', '--tsconfig', 'tsconfig.json', 'src/cli.ts', 'daemon'], {
  cwd: REPO_ROOT,
  env: { ...process.env, KAMI_LENS_DATA_DIR: DATA_DIR, NODE_OPTIONS: '--max-old-space-size=8192' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let live = false;
daemon.stdout.on('data', (d: Buffer) => {
  if (d.toString().includes('"state":"LIVE"')) live = true;
});
const daemonExit = new Promise<number | null>((resolve) => daemon.on('close', resolve));

for (let i = 0; i < 300 && !live; i++) await sleep(1000);
if (!live) {
  daemon.kill('SIGKILL');
  fail('G3.d', { reason: 'daemon did not reach LIVE within 300 s' });
}
await sleep(3000); // let the stream settle past backfill

// --- 2. daemon answers over the socket --------------------------------------
function socketQuery(query: string, args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = connect(SOCK);
    let buffer = '';
    conn.on('connect', () => conn.write(JSON.stringify({ id: 1, query, args }) + '\n'));
    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl >= 0) {
        conn.end();
        resolve(JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>);
      }
    });
    conn.on('error', reject);
  });
}

type DaemonKami = {
  id: string;
  index: number;
  name: string;
  state: string;
  level?: number;
  hp: { total: number };
};
const daemonAnswers = new Map<number, { data: DaemonKami; block: number }>();
for (const idx of KAMI_INDEXES) {
  const resp = (await socketQuery('kami', [String(idx)])) as unknown as {
    ok: boolean;
    data: DaemonKami;
    meta: { blockNumber: number };
  };
  if (!resp.ok) {
    daemon.kill('SIGTERM');
    fail('G3.d', { reason: 'daemon query failed', kami: idx, resp });
  }
  daemonAnswers.set(idx, { data: resp.data, block: resp.meta.blockNumber });
}

// --- 3. daemon down ----------------------------------------------------------
daemon.kill('SIGTERM');
await daemonExit;

// --- 4. stateless answers pinned to the daemon's block ----------------------
const config = resolveConfig();
const comparisons: Record<string, unknown>[] = [];
let mismatches = 0;
for (const [idx, { data: d, block }] of daemonAnswers) {
  const s = await statelessKami(config, idx, block);
  const checks = {
    id: BigInt(s.id) === BigInt(d.id),
    index: s.index === d.index,
    name: s.name === d.name,
    state: s.state === d.state,
    level: s.level === (d.level ?? -1),
    hpTotal: s.hp.total === d.hp.total,
  };
  const ok = Object.values(checks).every(Boolean);
  if (!ok) mismatches++;
  comparisons.push({ kami: idx, block, checks, stateless: s, daemon: d, ok });
}

// --- 5. CLI surface: stateless envelope + refusal code ----------------------
const cliOk = spawnSync(
  'npx',
  ['tsx', '--tsconfig', 'tsconfig.json', 'src/cli.ts', 'kami', String(KAMI_INDEXES[0]), '--stateless'],
  { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, KAMI_LENS_LOG_LEVEL: 'WARN' } }
);
let cliEnvelopeOk = false;
let cliSchemaOk = false;
if (cliOk.status === 0) {
  const parsed = JSON.parse(cliOk.stdout.slice(cliOk.stdout.indexOf('{'))) as {
    ok: boolean;
    data: unknown;
    untrusted: string[];
    meta: { mode: string };
  };
  cliEnvelopeOk = parsed.ok && parsed.meta.mode === 'stateless' && parsed.untrusted.includes('name');
  const ajv = new Ajv({ strict: true });
  cliSchemaOk = ajv.validate(loadSchema('kami-stateless' as never) as never, parsed.data) === true;
}
const cliRefusal = spawnSync(
  'npx',
  ['tsx', '--tsconfig', 'tsconfig.json', 'src/cli.ts', 'node', '10', '--stateless'],
  { cwd: REPO_ROOT, encoding: 'utf8' }
);
const refusalOk =
  cliRefusal.status === 5 && cliRefusal.stderr.includes('REQUIRES_DAEMON');

await writeMeasurement('g3d-stateless', {
  kamis: KAMI_INDEXES,
  comparisons,
  mismatches,
  cli: { exit: cliOk.status, envelopeOk: cliEnvelopeOk, schemaOk: cliSchemaOk },
  refusal: { exit: cliRefusal.status, ok: refusalOk },
  match: mismatches === 0 && cliOk.status === 0 && cliEnvelopeOk && cliSchemaOk && refusalOk,
});

if (mismatches > 0 || cliOk.status !== 0 || !cliEnvelopeOk || !cliSchemaOk || !refusalOk) {
  fail('G3.d', {
    reason: 'stateless mismatch',
    mismatches,
    comparisons: comparisons.filter((c) => !c.ok),
    cli: { exit: cliOk.status, cliEnvelopeOk, cliSchemaOk },
    refusal: { exit: cliRefusal.status, refusalOk },
  });
}
pass('G3.d', {
  kamis: KAMI_INDEXES.length,
  cliExit: cliOk.status,
  refusalExit: cliRefusal.status,
});
process.exit(0);
