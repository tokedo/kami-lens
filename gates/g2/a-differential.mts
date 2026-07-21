// Gate G2.a [hermetic] — differential vs upstream calcs. Materializes every
// kami in the mirror snapshot through the kami-lens stack, then runs the
// plan's calc set (calcHealth, calcOutput, calcBounty, calcCooldown,
// calcHealTime, liquidation thresholds) through BOTH implementations —
// kami-lens src in this process, the PINNED upstream clone in a subprocess
// whose alias map resolves only into the clone — over identical inputs with
// Date.now frozen to the same instant on both sides. Integer math must match
// exactly; zero tolerance (PORT_PLAN G2.a). Re-run on every pin advance
// (DESIGN §7).
//
// Hermetic: operates on the mirror snapshot artifact (gates/.artifacts/
// c2.v8snap, produced by the daemon / G1 runs) and the pinned clone
// (gates/.artifacts/upstream); no network. Liquidation thresholds are
// pairwise — each kami is paired with the next kami in query order (wrapping)
// for n deterministic attacker/defender pairs.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import path from 'node:path';

import * as clock from 'clock';
import { resolveConfig } from '../../src/config';
import { getKami } from '../../src/network/shapes/Kami';
import { query as queryKamis } from '../../src/network/shapes/Kami/queries';
import * as ourBase from '../../src/app/cache/kami/calcs/base';
import * as ourHarvestCalcs from '../../src/app/cache/harvest/calcs';
import * as ourKamiHarvest from '../../src/app/cache/kami/calcs/harvest';
import * as ourLiq from '../../src/app/cache/kami/calcs/liquidation';
import {
  ARTIFACTS_DIR,
  fail,
  loadCacheFromSnapshotFile,
  pass,
  REPO_ROOT,
  writeMeasurement,
} from '../g1/lib.mts';
import { buildMirror } from './lib.mts';

const G2_DIR = path.join(REPO_ROOT, 'gates', 'g2');
const UPSTREAM_DIR = path.join(ARTIFACTS_DIR, 'upstream');
const INPUTS = path.join(ARTIFACTS_DIR, 'g2a-inputs.ndjson');
const OURS = path.join(ARTIFACTS_DIR, 'g2a-ours.ndjson');
const THEIRS = path.join(ARTIFACTS_DIR, 'g2a-theirs.ndjson');
const SNAPSHOT = path.join(ARTIFACTS_DIR, 'c2.v8snap');

// --- 0. pinned clone present and at the pin --------------------------------
const pinLine = readFileSync(path.join(REPO_ROOT, 'UPSTREAM'), 'utf8')
  .split('\n')
  .find((l) => l.startsWith('commit '));
const PIN = pinLine!.split(/\s+/)[1];
if (!existsSync(UPSTREAM_DIR)) {
  fail('G2.a', {
    reason: 'pinned upstream clone missing',
    expected: `git clone https://github.com/Asphodel-OS/kamigotchi ${UPSTREAM_DIR} && git -C ${UPSTREAM_DIR} checkout ${PIN}`,
  });
}
const head = await new Promise<string>((resolve, reject) => {
  const p = spawn('git', ['-C', UPSTREAM_DIR, 'rev-parse', 'HEAD']);
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`git rev-parse exit ${code}`))));
});
if (head !== PIN) {
  fail('G2.a', { reason: 'upstream clone not at the pin', head, pin: PIN });
}

// --- 1. mirror ---------------------------------------------------------------
const config = resolveConfig();
if (!existsSync(SNAPSHOT)) {
  fail('G2.a', { reason: 'mirror snapshot missing (run G1 / the daemon first)', expected: SNAPSHOT });
}
const cache = await loadCacheFromSnapshotFile(SNAPSHOT, config);
const t0 = Date.now();
const { world, components, applied, unknown } = buildMirror(cache);
const mirrorMs = Date.now() - t0;

const KAMI_OPTS = {
  bonus: true,
  config: true,
  flags: true,
  harvest: true,
  progress: true,
  rerolls: true,
  skills: true,
  stats: true,
  time: true,
  traits: true,
};
const entities = queryKamis(components);
const t1 = Date.now();
const kamis = entities.map((e) => getKami(world, components, e, KAMI_OPTS));
const materializeMs = Date.now() - t1;
console.log(`[g2.a] mirror: block ${cache.blockNumber}, ${applied} entries (${unknown} unknown) in ${mirrorMs} ms`);
console.log(`[g2.a] materialized ${kamis.length} kamis in ${materializeMs} ms`);

// --- 2. serialize inputs (non-finite numbers encoded losslessly) ------------
let nonFinite = 0;
const replacer = (_key: string, v: unknown) => {
  if (typeof v === 'number' && !Number.isFinite(v)) {
    nonFinite++;
    return { __nonfinite: String(v) };
  }
  return v;
};
{
  const w = createWriteStream(INPUTS);
  for (let i = 0; i < kamis.length; i++) {
    w.write(JSON.stringify({ i, kami: kamis[i] }, replacer) + '\n');
  }
  await new Promise((resolve) => w.end(resolve));
}
if (nonFinite > 0) console.log(`[g2.a] note: ${nonFinite} non-finite input values encoded`);

// Both sides compute from the round-tripped JSON, so JSON.stringify quirks
// (undefined-property dropping) are common-mode by construction.
const roundTripped: { i: number; kami: (typeof kamis)[number] }[] = [];
{
  const revive = (_key: string, v: unknown) =>
    v && typeof v === 'object' && '__nonfinite' in (v as Record<string, unknown>)
      ? Number((v as { __nonfinite: string }).__nonfinite)
      : v;
  const rl = createInterface({ input: createReadStream(INPUTS), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) roundTripped.push(JSON.parse(line, revive));
  }
}

// --- 3. our side, clock frozen ----------------------------------------------
const NOW_MS = Date.now();
type CalcRow = {
  i: number;
  health: number;
  healTime: number;
  cooldown: number;
  output: number;
  bounty: number | null;
  threshold: number;
};
const ours: CalcRow[] = [];
{
  const realNow = Date.now;
  Date.now = () => NOW_MS;
  clock.reset(); // offset 0: clock.now() === frozen Date.now(), upstream mode
  try {
    const n = roundTripped.length;
    for (let idx = 0; idx < n; idx++) {
      const { i, kami } = roundTripped[idx];
      const defender = roundTripped[(idx + 1) % n].kami;
      ours.push({
        i,
        health: ourBase.calcHealth(kami),
        healTime: ourBase.calcHealTime(kami),
        cooldown: ourBase.calcCooldown(kami),
        output: ourKamiHarvest.calcOutput(kami),
        bounty: kami.harvest ? ourHarvestCalcs.calcBounty(kami.harvest) : null,
        threshold: ourLiq.calcThreshold(kami, defender),
      });
    }
  } finally {
    Date.now = realNow;
  }
}
{
  // Same non-finite encoding as the inputs and the upstream runner's output,
  // so both sides' rows compare NaN-to-NaN rather than null-to-NaN.
  const w = createWriteStream(OURS);
  for (const row of ours) w.write(JSON.stringify(row, replacer) + '\n');
  await new Promise((resolve) => w.end(resolve));
}

// --- 4. upstream side (subprocess, clone-only alias map) --------------------
const t2 = Date.now();
const runnerExit = await new Promise<number>((resolve) => {
  const p = spawn(
    'npx',
    ['tsx', '--tsconfig', path.join(G2_DIR, 'tsconfig.upstream.json'), path.join(G2_DIR, 'a-upstream-runner.mts'), INPUTS, THEIRS, String(NOW_MS)],
    {
      cwd: G2_DIR,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        NODE_OPTIONS: `--import ${path.join(G2_DIR, 'register-assets.mjs')} --max-old-space-size=8192`,
      },
    }
  );
  p.on('close', (code) => resolve(code ?? 1));
});
if (runnerExit !== 0) {
  fail('G2.a', { reason: 'upstream runner failed', exitCode: runnerExit });
}
const upstreamMs = Date.now() - t2;

// --- 5. compare: exact equality, zero tolerance -----------------------------
const reviveRow = (_key: string, v: unknown) =>
  v && typeof v === 'object' && '__nonfinite' in (v as Record<string, unknown>)
    ? Number((v as { __nonfinite: string }).__nonfinite)
    : v;
const theirs = new Map<number, CalcRow>();
{
  const rl = createInterface({ input: createReadStream(THEIRS), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line, reviveRow) as CalcRow;
    theirs.set(row.i, row);
  }
}
const FIELDS = ['health', 'healTime', 'cooldown', 'output', 'bounty', 'threshold'] as const;
let compared = 0;
let mismatchCount = 0;
const mismatches: Record<string, unknown>[] = [];
for (const row of ours) {
  const other = theirs.get(row.i);
  if (!other) {
    mismatchCount++;
    mismatches.push({ i: row.i, reason: 'missing upstream row' });
    continue;
  }
  for (const f of FIELDS) {
    compared++;
    if (!Object.is(row[f], other[f])) {
      mismatchCount++;
      if (mismatches.length < 25) {
        mismatches.push({ i: row.i, field: f, ours: row[f], upstream: other[f] });
      }
    }
  }
}

await writeMeasurement('g2a-differential', {
  pin: PIN,
  snapshotBlock: cache.blockNumber,
  mirrorEntries: applied,
  kamis: kamis.length,
  comparisonsPerKami: FIELDS.length,
  comparisons: compared,
  nowMs: NOW_MS,
  nonFiniteInputValues: nonFinite,
  mirrorMs,
  materializeMs,
  upstreamMs,
  mismatches: mismatchCount,
  mismatchSamples: mismatches.slice(0, 25),
  match: mismatchCount === 0 && ours.length === theirs.size && ours.length > 0,
});

if (mismatchCount > 0 || ours.length !== theirs.size || ours.length === 0) {
  fail('G2.a', {
    reason: 'differential mismatch',
    mismatches: mismatchCount,
    ours: ours.length,
    theirs: theirs.size,
    samples: mismatches.slice(0, 10),
  });
}
pass('G2.a', {
  kamis: kamis.length,
  comparisons: compared,
  snapshotBlock: cache.blockNumber,
  pin: PIN,
});
process.exit(0);
