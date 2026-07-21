// Gate G2.a, upstream side. Runs under gates/g2/tsconfig.upstream.json, so
// every 'app/*'/'network/*'/'engine/*' specifier resolves into the PINNED
// upstream clone (gates/.artifacts/upstream) — kami-lens src is not on the
// alias map and cannot leak in. Reads the input NDJSON of materialized kami
// objects, replays the plan's calc set through the upstream modules, writes
// output NDJSON. Date.now is frozen to the harness's NOW_MS before the
// upstream modules are imported, matching the parent's frozen clock.
//
// Usage: tsx --tsconfig tsconfig.upstream.json a-upstream-runner.mts \
//          <inputs.ndjson> <outputs.ndjson> <nowMs>
// (invoked with NODE_OPTIONS=--import register-assets.mjs for binary images)

import { createInterface } from 'node:readline';
import { createReadStream, createWriteStream } from 'node:fs';

const [inputPath, outputPath, nowMsArg] = process.argv.slice(2);
const NOW_MS = Number(nowMsArg);
if (!inputPath || !outputPath || !Number.isFinite(NOW_MS)) {
  console.error('usage: a-upstream-runner.mts <inputs.ndjson> <outputs.ndjson> <nowMs>');
  process.exit(2);
}

Date.now = () => NOW_MS;

// Dynamic imports AFTER the clock freeze (top-level imports would hoist).
const base = await import('app/cache/kami/calcs/base');
const harvestCalcs = await import('app/cache/kami/calcs/harvest');
const liq = await import('app/cache/kami/calcs/liquidation');
const appHarvest = await import('app/cache/harvest/calcs');

const revive = (_key: string, v: unknown) =>
  v && typeof v === 'object' && '__nonfinite' in (v as Record<string, unknown>)
    ? Number((v as { __nonfinite: string }).__nonfinite)
    : v;
// Non-finite calc results (e.g. calcHealTime's NaN/Infinity off the RESTING
// state) must round-trip losslessly — JSON.stringify would fold them to null.
const replacer = (_key: string, v: unknown) =>
  typeof v === 'number' && !Number.isFinite(v) ? { __nonfinite: String(v) } : v;

const kamis: { i: number; kami: Parameters<typeof base.calcHealth>[0] }[] = [];
const rl = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
for await (const line of rl) {
  if (line.trim()) kamis.push(JSON.parse(line, revive));
}

const out = createWriteStream(outputPath);
const n = kamis.length;
for (let idx = 0; idx < n; idx++) {
  const { i, kami } = kamis[idx];
  const defender = kamis[(idx + 1) % n].kami;
  const result = {
    i,
    health: base.calcHealth(kami),
    healTime: base.calcHealTime(kami),
    cooldown: base.calcCooldown(kami),
    output: harvestCalcs.calcOutput(kami),
    bounty: kami.harvest ? appHarvest.calcBounty(kami.harvest) : null,
    threshold: liq.calcThreshold(kami, defender),
  };
  out.write(JSON.stringify(result, replacer) + '\n');
}
await new Promise((resolve, reject) => out.end((err: unknown) => (err ? reject(err) : resolve(null))));
console.error(`[upstream-runner] computed ${n} kamis at NOW_MS=${NOW_MS}`);
