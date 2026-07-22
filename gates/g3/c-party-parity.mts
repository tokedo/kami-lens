// Gate G3.c [live] — party report parity. The own-operator report (the
// party QUERY, through the full serve path) must match the official
// client's party modal — fixtures-file protocol as in G2.b, reusing the
// same screenshot transcription (gates/fixtures/g2b-observations.json) and
// the same replay/frozen-clock method. What G2.b proved for the ported
// calc path, this gate proves for the SERVED QUERY: the query's rows carry
// the same vitals the client displayed.
//
// Tolerances mirror G2.b: HP and accrued musu ±2, cooldown ±2 s, state
// token exact (query state RESTING/HARVESTING vs display Resting/
// Harvesting, case-folded; moods are UI constants, not compared), both
// rate strings must match at one common instant in the client's lawful
// staleness window (1 s τ-sweep over [capture − 65 s, capture]). Hygiene:
// rows the G2.b measurement rejected for on-chain actions inside the
// window are skipped here by that record (cited, not recomputed).
//
// Replay base (2026-07-22 audit finding): the base is the fixture set's
// OWN pinned snapshot (manifest replayBase — file + expected block), not
// the shared mutable c2.v8snap, which later gate runs refresh past the
// observation blocks; replayOnto silently no-ops backward and the gate
// would compare head-state under a frozen capture clock. Guard: refuse
// and report when the pin is absent, the artifact is missing, its block
// differs from the pin, or it postdates any observation block.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import * as clock from 'clock';
import { resolveConfig } from '../../src/config';
import { serveQuery } from '../../src/queries';
import { KamiCache } from '../../src/app/cache/kami/base';
import { getKamiAccount } from '../../src/app/cache/kami';
import { queryByIndex as queryKamiByIndex } from '../../src/network/shapes/Kami/queries';
import {
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
import { buildMirror } from '../g2/lib.mts';

type PartyRow = {
  kamiIndex: number;
  hp: { current: number; total: number; percent?: number };
  stateText: string;
  nodeName?: string;
  musuAccrued?: number;
  musuRatePerHr?: string;
  hpRatePerHr?: string;
  cooldown: string;
};
type Screenshot = { file: string; capturedAtMs: number; views: { party?: PartyRow[] } };

const FIXTURES = path.join(REPO_ROOT, 'gates', 'fixtures', 'g2b-observations.json');
if (!existsSync(FIXTURES)) fail('G3.c', { reason: 'fixtures missing', expected: FIXTURES });
const fixture = JSON.parse(readFileSync(FIXTURES, 'utf8')) as {
  replayBase?: { file: string; blockNumber: number };
  screenshots: Screenshot[];
};
if (!fixture.replayBase) {
  fail('G3.c', { reason: 'fixtures manifest lacks the replayBase pin — refusing to guess a base' });
}
const SNAPSHOT = path.join(REPO_ROOT, fixture.replayBase!.file);
if (!existsSync(SNAPSHOT)) {
  fail('G3.c', {
    reason: 'pinned replay-base artifact missing — a lost base means a fresh capture event (operator decision), never a substitute base',
    expected: SNAPSHOT,
    pinnedBlock: fixture.replayBase!.blockNumber,
  });
}

// hygiene: G2.b's recorded rejections
const g2bMeasurements = readFileSync(
  path.join(REPO_ROOT, 'docs', 'measurements', 'g2b-display-parity-2026-07-21.json'),
  'utf8'
);
const g2b = JSON.parse(g2bMeasurements) as {
  observationBlocks: Record<string, number>;
  rejections: { screenshot: string; kami: number | string }[];
};
const rejected = new Set(g2b.rejections.map((r) => `${r.screenshot}:${r.kami}`));

const config = resolveConfig();
const baseCache = await loadCacheFromSnapshotFile(SNAPSHOT, config);
const provider = makeProvider(config);
const fetchWorldEvents = makeFetchWorldEvents(provider, config);

const distinctBlocks = [...new Set(Object.values(g2b.observationBlocks))].sort((a, b) => a - b);
// --- the loud precondition guard (refuse-and-report, never a silent
// wrong-state comparison): the base must be the pinned block and must
// predate every observation block, or replayOnto cannot reach them.
if (baseCache.blockNumber !== fixture.replayBase!.blockNumber) {
  fail('G3.c', {
    reason: 'replay-base artifact does not match its manifest pin',
    artifactBlock: baseCache.blockNumber,
    pinnedBlock: fixture.replayBase!.blockNumber,
    file: fixture.replayBase!.file,
  });
}
if (baseCache.blockNumber > distinctBlocks[0]) {
  fail('G3.c', {
    reason:
      'replay base postdates the earliest observation block — a forward replay cannot reach the fixtures; refusing the comparison',
    baseBlock: baseCache.blockNumber,
    earliestObservationBlock: distinctBlocks[0],
  });
}
const mirrors = new Map<number, ReturnType<typeof buildMirror>>();
{
  let rolling = cloneStateCache(baseCache);
  for (const b of distinctBlocks) {
    await replayOnto(rolling, fetchWorldEvents, b);
    mirrors.set(b, buildMirror(rolling));
    rolling = cloneStateCache(rolling);
  }
}
provider.destroy();

type QueryKami = {
  index: number;
  state: string;
  hp: { current: number; total: number; percent: number };
  hpRatePerHr: string;
  musu?: { accrued: number; spotRatePerHr: string };
  cooldownSec: number;
  node?: { name: string };
};

const realNow = Date.now;
// serveQuery is async since M4; the party builder itself is synchronous
// chain-only code, so the Date.now freeze still spans the whole
// computation (nothing else can interleave in this single script).
async function partyAt(
  mirrorBlock: number,
  accountIndex: number,
  frozenMs: number
): Promise<Map<number, QueryKami>> {
  const m = mirrors.get(mirrorBlock)!;
  Date.now = () => frozenMs;
  clock.reset();
  try {
    KamiCache.clear();
    const out = (
      await serveQuery({ ...m, blockNumber: mirrorBlock }, 'party', [String(accountIndex)], {
        stale: false,
        mode: 'daemon',
      })
    ).data as { kamis: QueryKami[] };
    return new Map(out.kamis.map((k) => [k.index, k]));
  } finally {
    Date.now = realNow;
  }
}

const rows: Record<string, unknown>[] = [];
const skips: Record<string, unknown>[] = [];
let failures = 0;
let compared = 0;

for (const shot of fixture.screenshots) {
  const party = shot.views.party ?? [];
  if (party.length === 0) continue;
  const obsBlock = g2b.observationBlocks[shot.file];
  const m = mirrors.get(obsBlock)!;

  // resolve the account from the first party kami's owner (machine-side)
  KamiCache.clear();
  const anchor = queryKamiByIndex(m.world, m.components, party[0].kamiIndex);
  if (anchor === undefined) {
    fail('G3.c', { reason: 'anchor kami missing from mirror', screenshot: shot.file });
  }
  const accountIndex = getKamiAccount(m.world, m.components, anchor!).index;

  // rate coherence: one τ in the window must satisfy BOTH strings per row —
  // sweep once per screenshot, tracking per-row satisfaction
  // The off=0 pass IS the capture answer — the app/cache TTL maps demand
  // strictly increasing frozen times, so re-materializing at the same
  // instant would serve half-refreshed kamis.
  const satisfiedAt = new Map<number, number>();
  let atCapture = new Map<number, QueryKami>();
  for (let off = 65; off >= 0; off--) {
    const q = await partyAt(obsBlock, accountIndex, shot.capturedAtMs - off * 1000);
    if (off === 0) atCapture = q;
    for (const row of party) {
      if (satisfiedAt.has(row.kamiIndex)) continue;
      const k = q.get(row.kamiIndex);
      if (!k) continue;
      const musuOk =
        row.musuRatePerHr === undefined || k.musu?.spotRatePerHr === row.musuRatePerHr;
      const hpOk = row.hpRatePerHr === undefined || k.hpRatePerHr === row.hpRatePerHr;
      if (musuOk && hpOk) satisfiedAt.set(row.kamiIndex, off);
    }
  }
  for (const row of party) {
    const key = `${shot.file}:${row.kamiIndex}`;
    if (rejected.has(key)) {
      skips.push({ row: key, reason: 'rejected by the G2.b hygiene record' });
      continue;
    }
    const k = atCapture.get(row.kamiIndex);
    if (!k) {
      failures++;
      rows.push({ row: key, error: 'kami missing from party query answer', ok: false });
      continue;
    }
    compared++;
    const displayedCooldown = row.cooldown === 'ready' ? 0 : Number(row.cooldown.replace(/s$/, ''));
    const stateToken = row.stateText.split(' while ')[0].toUpperCase();
    const checks = {
      state: k.state.toUpperCase() === stateToken,
      hp: Math.abs(k.hp.current - row.hp.current) <= 2 && k.hp.total === row.hp.total,
      percent: row.hp.percent === undefined || Math.abs(k.hp.percent - row.hp.percent) <= 2,
      node: row.nodeName === undefined || k.node?.name === row.nodeName,
      musu:
        row.musuAccrued === undefined || Math.abs((k.musu?.accrued ?? -99) - row.musuAccrued) <= 2,
      cooldown: Math.abs(k.cooldownSec - displayedCooldown) <= 2,
      rates:
        (row.musuRatePerHr === undefined && row.hpRatePerHr === undefined) ||
        satisfiedAt.has(row.kamiIndex),
    };
    const ok = Object.values(checks).every(Boolean);
    if (!ok) failures++;
    rows.push({
      row: key,
      checks,
      rateMatchedAtSecondsBeforeCapture: satisfiedAt.get(row.kamiIndex),
      ok,
    });
  }
}

await writeMeasurement('g3c-party-parity', {
  fixtures: 'gates/fixtures/g2b-observations.json (G2.b protocol, reused)',
  hygieneSource: 'g2b-display-parity-2026-07-21.json rejections',
  observationBlocks: g2b.observationBlocks,
  compared,
  skips: skips.length,
  failures,
  rows,
  match: failures === 0 && compared >= 10,
});

if (failures > 0 || compared < 10) {
  fail('G3.c', { reason: 'party parity mismatch', failures, compared, rows: rows.filter((r) => !r.ok) });
}
pass('G3.c', { compared, skips: skips.length });
process.exit(0);
