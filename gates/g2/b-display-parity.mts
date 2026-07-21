// Gate G2.b [live + human data entry] — display parity vs the official web
// client. A human records, from the official client with the daemon's chain
// in view, ≥ 10 kamis spanning states (HARVESTING, RESTING, on-cooldown,
// near-starving) into gates/fixtures/g2b-observations.json. This script
// replays kami-lens projection at each recorded (blockHeight, wallTimestamp)
// and asserts agreement within display rounding: HP to the integer, musu to
// the floor, cooldown to the second — each with ±1 display-unit slack for
// human entry timing jitter; state label exact. The observations are data;
// the verdict is this script's exit code (PORT_PLAN G2.b).
//
// Mechanics: the mirror snapshot (gates/.artifacts/c2.v8snap) is healed
// forward to each observation's blockHeight via RPC replay (observations
// must be at/after the snapshot block and within the RPC retention window,
// ~25 days). The §3.8 clock is frozen to the recorded wall timestamp — the
// observer's clock is the same clock the web client rendered with, so the
// comparison basis is exactly the client's.
//
// Fixture schema (see g2b-observations.template.json):
//   { "observations": [ { "kamiIndex": number, "blockHeight": number,
//       "wallTimestampMs": number, "stateLabel": string,
//       "displayedHP": number, "displayedMusu": number,
//       "displayedCooldownSec": number } ] }

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import * as clock from 'clock';
import { resolveConfig } from '../../src/config';
import { getKami } from '../../src/network/shapes/Kami';
import { queryByIndex } from '../../src/network/shapes/Kami/queries';
import * as calcsBase from '../../src/app/cache/kami/calcs/base';
import * as calcsHarvest from '../../src/app/cache/kami/calcs/harvest';
import {
  ARTIFACTS_DIR,
  REPO_ROOT,
  cloneStateCache,
  fail,
  loadCacheFromSnapshotFile,
  makeFetchWorldEvents,
  makeProvider,
  pass,
  replayOnto,
  writeMeasurement,
} from '../g1/lib.mts';
import { buildMirror } from './lib.mts';

const FIXTURES = path.join(REPO_ROOT, 'gates', 'fixtures', 'g2b-observations.json');
const SNAPSHOT = path.join(ARTIFACTS_DIR, 'c2.v8snap');

type Observation = {
  kamiIndex: number;
  blockHeight: number;
  wallTimestampMs: number;
  stateLabel: string;
  displayedHP: number;
  displayedMusu: number;
  displayedCooldownSec: number;
};

if (!existsSync(FIXTURES)) {
  fail('G2.b', {
    reason: 'observation fixtures missing (operational prerequisite: observer account + human data entry from the official client)',
    expected: FIXTURES,
    template: path.join(REPO_ROOT, 'gates', 'fixtures', 'g2b-observations.template.json'),
  });
}
const { observations } = JSON.parse(readFileSync(FIXTURES, 'utf8')) as {
  observations: Observation[];
};
if (!Array.isArray(observations) || observations.length < 10) {
  fail('G2.b', { reason: 'need ≥ 10 observations spanning states', got: observations?.length ?? 0 });
}
const states = new Set(observations.map((o) => o.stateLabel));

if (!existsSync(SNAPSHOT)) {
  fail('G2.b', { reason: 'mirror snapshot missing (run G1 / the daemon first)', expected: SNAPSHOT });
}
const config = resolveConfig();
const baseCache = await loadCacheFromSnapshotFile(SNAPSHOT, config);
const provider = makeProvider(config);
const fetchWorldEvents = makeFetchWorldEvents(provider, config);

// Heal once per distinct height, ascending, reusing the previous heal.
const heights = [...new Set(observations.map((o) => o.blockHeight))].sort((a, b) => a - b);
if (heights[0] < baseCache.blockNumber) {
  fail('G2.b', {
    reason: 'observation predates the mirror snapshot — record fresh observations or supply an older snapshot',
    snapshotBlock: baseCache.blockNumber,
    earliestObservation: heights[0],
  });
}
let rolling = cloneStateCache(baseCache);
const mirrors = new Map<number, ReturnType<typeof buildMirror>>();
for (const h of heights) {
  await replayOnto(rolling, fetchWorldEvents, h);
  mirrors.set(h, buildMirror(rolling));
  rolling = cloneStateCache(rolling);
}
provider.destroy();

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

type Row = Record<string, unknown>;
const rows: Row[] = [];
let failures = 0;
const realNow = Date.now;
try {
  for (const obs of observations) {
    const { world, components } = mirrors.get(obs.blockHeight)!;
    const entity = queryByIndex(world, components, obs.kamiIndex);
    if (entity === undefined) {
      failures++;
      rows.push({ ...obs, error: 'kami index not found in mirror' });
      continue;
    }

    Date.now = () => obs.wallTimestampMs;
    clock.reset(); // offset 0: now() === the recorded wall instant
    const kami = getKami(world, components, entity, KAMI_OPTS);
    const hp = Math.round(calcsBase.calcHealth(kami));
    const musu = Math.floor(calcsHarvest.calcOutput(kami));
    const cooldownSec = Math.round(calcsBase.calcCooldown(kami));
    Date.now = realNow;

    const dHP = Math.abs(hp - obs.displayedHP);
    const dMusu = Math.abs(musu - obs.displayedMusu);
    const dCooldown = Math.abs(cooldownSec - obs.displayedCooldownSec);
    const stateOk = kami.state === obs.stateLabel;
    const ok = dHP <= 1 && dMusu <= 1 && dCooldown <= 1 && stateOk;
    if (!ok) failures++;
    rows.push({
      kamiIndex: obs.kamiIndex,
      blockHeight: obs.blockHeight,
      state: { ours: kami.state, displayed: obs.stateLabel, ok: stateOk },
      hp: { ours: hp, displayed: obs.displayedHP, delta: dHP },
      musu: { ours: musu, displayed: obs.displayedMusu, delta: dMusu },
      cooldownSec: { ours: cooldownSec, displayed: obs.displayedCooldownSec, delta: dCooldown },
      ok,
    });
  }
} finally {
  Date.now = realNow;
}

await writeMeasurement('g2b-display-parity', {
  snapshotBlock: baseCache.blockNumber,
  observations: observations.length,
  statesCovered: [...states],
  failures,
  rows,
  match: failures === 0,
});

if (failures > 0) {
  fail('G2.b', { reason: 'display parity mismatch', failures, rows: rows.filter((r) => !r.ok) });
}
pass('G2.b', {
  observations: observations.length,
  statesCovered: [...states],
});
process.exit(0);
