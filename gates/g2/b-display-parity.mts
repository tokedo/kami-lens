// Gate G2.b [live + hand-captured screenshots, session-transcribed] —
// display parity vs the official web client (PORT_PLAN G2.b, decision
// 2026-07-21). The operator drops original screenshots into
// gates/fixtures/g2b-screenshots/; the transcription lives in
// gates/fixtures/g2b-observations.json (schema v2); this script does
// everything else machine-side:
//
//   - capture instant per screenshot from the original filename/mtime;
//     blockHeight derived by bisecting RPC block timestamps (no ticker in
//     frame; ± a block is absorbed by tolerance);
//   - the mirror snapshot (gates/.artifacts/c2.v8snap) is healed forward to
//     each observation block; comparisons run with the wall clock frozen to
//     the capture instant (the observer's clock is the client's render
//     clock) through the SAME data path the client renders from: the
//     app/cache kami getter with all-zero TTLs, then the exact render
//     formulas (verified against the pinned client source):
//       hp        = calcHealth(kami) / stats.health.total, percent toFixed(0)
//                   [party StatusDisplay / KamiBar showHealth]
//       state     = Resting | Murdered | Starving | Harvesting ("while
//                   <mood>" suffixes are UI constants (constants/kamis HP
//                   bands), not derived by the ported unit — coverage note,
//                   not compared)
//       rates     = getRateDisplay(harvest.rates.total.spot, 2) MUSU/hr and
//                   getRateDisplay(stats.health.rate, 2) HP/hr
//                   [party StatusDisplay] — PRIMARY comparison fields,
//                   time-invariant between state changes, exact at shown
//                   precision
//       musu      = calcOutput(kami)  [KamiBar tooltip / EnemyKards label]
//       cooldown  = calcCooldown(kami); displayed 'ready' ⇔ 0, else
//                   `${Math.floor(s)}s`  [CountdownBar]
//       inventory = cleanInventories(account.inventories) — MUSU removed,
//                   empties filtered, sorted by item index [Inventory modal]
//                   — discrete-event state: STRICT, zero tolerance; balance
//                   = getBalance(inventories, MUSU_INDEX)
//   - tolerances: HP and accrued musu ±2 display units; cooldown ±2 s;
//     zero-bias check — ≥4 nonzero same-signed deltas with none opposite on
//     any toleranced field fails the gate even inside tolerance;
//   - machine-side hygiene, all logged: rows rejected when the kami's
//     discrete action markers (state, time.last, time.cooldown,
//     harvest.time.start/reset, progress.level) differ between the replay
//     basis and the observation block (an on-chain action inside the
//     window); operator-controlled kami indexes are skipped in third-party
//     room views.
//
// The observations are data; the verdict is this script's exit code.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import * as clock from 'clock';
import { resolveConfig } from '../../src/config';
import {
  calcCooldown,
  calcHealth,
  calcOutput,
  getKami,
  getKamiAccount,
} from '../../src/app/cache/kami';
import { KamiCache } from '../../src/app/cache/kami/base';
import { cleanInventories, getInventoryBalance } from '../../src/app/cache/inventory';
import { getByName as getKamiByName } from '../../src/network/shapes/Kami/getters';
import { queryByIndex as queryKamiByIndex } from '../../src/network/shapes/Kami/queries';
import { getRateDisplay } from '../../src/utils/numbers';
import { MUSU_INDEX } from '../../src/constants/items';
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
import { buildMirror } from './lib.mts';

// Operator-controlled kamis: excluded from third-party room comparisons
// (self-observation would compare the operator's own agents against
// themselves).
const EXCLUDED_KAMI_INDEXES = new Set([17379, 17992, 20042]);

const FIXTURES = path.join(REPO_ROOT, 'gates', 'fixtures', 'g2b-observations.json');
// The replay base is the fixture set's OWN pinned snapshot (manifest
// replayBase entry — 2026-07-22 audit finding), never the shared mutable
// c2.v8snap, which later gate runs refresh past the observation blocks.

type Hp = { current: number; total: number; percent?: number };
type PartyRow = {
  kamiIndex: number;
  hp: Hp;
  stateText: string;
  nodeName?: string;
  musuAccrued?: number;
  musuRatePerHr?: string;
  hpRatePerHr?: string;
  cooldown: string;
  uncertain?: string[];
};
type EnemyRow = {
  kamiName: string;
  kamiIndex?: number;
  hp: Hp;
  cooldown: string;
  musuAccrued: number;
  ownerName: string;
  uncertain?: string[];
};
type Screenshot = {
  file: string;
  capturedAtMs: number;
  views: {
    party?: PartyRow[];
    roomEnemies?: { nodeName: string; enemiesTotal: number; rows: EnemyRow[] };
    inventory?: {
      musuBalance: number;
      complete: boolean;
      countsInGridOrder: number[];
      uncertainCells: number[];
      gridIllegible?: boolean;
    };
  };
};

if (!existsSync(FIXTURES)) {
  fail('G2.b', { reason: 'transcription fixture missing', expected: FIXTURES });
}
const fixture = JSON.parse(readFileSync(FIXTURES, 'utf8')) as {
  schema: string;
  replayBase?: { file: string; blockNumber: number };
  screenshots: Screenshot[];
};
if (fixture.schema !== 'g2b-screenshot-transcription-v2') {
  fail('G2.b', { reason: 'unexpected fixture schema', got: fixture.schema });
}
if (!fixture.replayBase) {
  fail('G2.b', { reason: 'fixtures manifest lacks the replayBase pin — refusing to guess a base' });
}
const SNAPSHOT = path.join(REPO_ROOT, fixture.replayBase!.file);
if (!existsSync(SNAPSHOT)) {
  fail('G2.b', {
    reason: 'pinned replay-base artifact missing — a lost base means a fresh capture event (operator decision), never a substitute base',
    expected: SNAPSHOT,
    pinnedBlock: fixture.replayBase!.blockNumber,
  });
}

// --- 1. derive observation blocks (RPC bisection over block timestamps) -----
const config = resolveConfig();
const provider = makeProvider(config);
const baseCache = await loadCacheFromSnapshotFile(SNAPSHOT, config);
if (baseCache.blockNumber !== fixture.replayBase!.blockNumber) {
  fail('G2.b', {
    reason: 'replay-base artifact does not match its manifest pin',
    artifactBlock: baseCache.blockNumber,
    pinnedBlock: fixture.replayBase!.blockNumber,
    file: fixture.replayBase!.file,
  });
}

async function blockTs(n: number): Promise<number> {
  const b = await provider.getBlock(n);
  if (!b) throw new Error(`getBlock(${n}) returned null`);
  return b.timestamp;
}
// last block with timestamp <= ts (what the client's mirror had rendered)
async function blockForTimestamp(tsSec: number, lo: number, hi: number): Promise<number> {
  if ((await blockTs(lo)) > tsSec) {
    throw new Error(`capture ${tsSec} predates replay basis block ${lo}`);
  }
  while (lo < hi) {
    const m = Math.floor((lo + hi + 1) / 2);
    if ((await blockTs(m)) <= tsSec) lo = m;
    else hi = m - 1;
  }
  return lo;
}

const head = await provider.getBlockNumber();
const obsBlocks = new Map<string, number>();
for (const shot of fixture.screenshots) {
  const tsSec = Math.floor(shot.capturedAtMs / 1000);
  obsBlocks.set(shot.file, await blockForTimestamp(tsSec, baseCache.blockNumber, head));
}
console.log('[g2.b] derived observation blocks:', Object.fromEntries(obsBlocks));

// --- 2. build mirrors: basis + one per distinct observation block -----------
const distinctBlocks = [...new Set(obsBlocks.values())].sort((a, b) => a - b);
// loud precondition (refuse-and-report, never a silent wrong-state
// comparison): the base must predate every observation block or the
// forward replay cannot reach the fixtures
if (baseCache.blockNumber > distinctBlocks[0]) {
  fail('G2.b', {
    reason: 'replay base postdates the earliest observation block — refusing the comparison',
    baseBlock: baseCache.blockNumber,
    earliestObservationBlock: distinctBlocks[0],
  });
}
const basisMirror = buildMirror(baseCache);
const obsMirrors = new Map<number, ReturnType<typeof buildMirror>>();
{
  let rolling = cloneStateCache(baseCache);
  const fetchWorldEvents = makeFetchWorldEvents(provider, config);
  for (const b of distinctBlocks) {
    await replayOnto(rolling, fetchWorldEvents, b);
    obsMirrors.set(b, buildMirror(rolling));
    rolling = cloneStateCache(rolling);
  }
}
provider.destroy();

// --- 3. frozen-clock materialization + comparison ---------------------------
const FULL_REFRESH = {
  live: 0,
  base: 0,
  bonuses: 0,
  config: 0,
  flags: 0,
  harvest: 0,
  progress: 0,
  rerolls: 0,
  skills: 0,
  stats: 0,
  time: 0,
  traits: 0,
};

type Mirror = ReturnType<typeof buildMirror>;
const realNow = Date.now;

// Caller must hold the clock freeze (see compareRow); the TTL trick: the
// basis pass materializes 1 s earlier so the obs pass's TTL delta is > 0.
function materialize(mirror: Mirror, entity: number, frozenMs: number) {
  const prev = Date.now;
  Date.now = () => frozenMs;
  try {
    return getKami(mirror.world, mirror.components, entity as never, FULL_REFRESH);
  } finally {
    Date.now = prev;
  }
}

function resolveEntity(mirror: Mirror, row: { kamiIndex?: number; kamiName?: string }) {
  if (row.kamiIndex !== undefined) {
    return queryKamiByIndex(mirror.world, mirror.components, row.kamiIndex);
  }
  const kamis = getKamiByName(mirror.world, mirror.components, row.kamiName!);
  return kamis.length > 0 && kamis[0].index !== 0 ? kamis[0].entity : undefined;
}

type Marker = Record<string, unknown>;
function actionMarkers(k: ReturnType<typeof getKami>): Marker {
  return {
    state: k.state,
    timeLast: k.time?.last,
    timeCooldown: k.time?.cooldown,
    harvestStart: k.harvest?.time?.start,
    harvestReset: k.harvest?.time?.reset,
    level: k.progress?.level,
  };
}

function stateToken(k: ReturnType<typeof getKami>): string {
  // party StatusDisplay header logic, verbatim order
  if (k.state === 'RESTING') return 'Resting';
  if (k.state === 'DEAD') return 'Murdered';
  if (k.state === 'HARVESTING' && k.harvest) {
    return calcHealth(k) === 0 ? 'Starving' : 'Harvesting';
  }
  return k.state;
}

const rows: Record<string, unknown>[] = [];
const rejections: Record<string, unknown>[] = [];
const skips: Record<string, unknown>[] = [];
const deltas: Record<'hp' | 'musu' | 'cooldown', number[]> = { hp: [], musu: [], cooldown: [] };
let failures = 0;
const kamisCompared = new Set<number>();
const accountsSeen = new Set<string>();

function compareRow(shot: Screenshot, row: PartyRow | EnemyRow, kind: 'party' | 'enemy'): void {
  // The ENTIRE comparison — materialization AND every calc — runs with the
  // wall clock frozen at the capture instant; a calc outside the freeze
  // would accrue real session time and make the comparison non-deterministic.
  Date.now = () => shot.capturedAtMs;
  clock.reset();
  try {
    compareRowFrozen(shot, row, kind);
  } finally {
    Date.now = realNow;
  }
}

function compareRowFrozen(
  shot: Screenshot,
  row: PartyRow | EnemyRow,
  kind: 'party' | 'enemy'
): void {
  const obsBlock = obsBlocks.get(shot.file)!;
  const mirror = obsMirrors.get(obsBlock)!;
  const label = { screenshot: shot.file, kind, kami: row.kamiIndex ?? (row as EnemyRow).kamiName };

  if (kind === 'enemy' && row.kamiIndex !== undefined && EXCLUDED_KAMI_INDEXES.has(row.kamiIndex)) {
    skips.push({ ...label, reason: 'operator-controlled kami excluded from third-party comparison' });
    return;
  }

  // Materialization order is TTL-driven (the app/cache maps demand strictly
  // increasing frozen times): previous-tick pass (t−60 s) → basis pass
  // (t−1 s, hygiene) → observation pass (t).
  KamiCache.clear();
  const entity = resolveEntity(mirror, row);
  if (entity === undefined) {
    rejections.push({ ...label, reason: 'kami not found in observation mirror' });
    return;
  }
  // hygiene: discrete action markers must not change basis → observation
  const basisEntity = resolveEntity(basisMirror, row);
  if (basisEntity === undefined) {
    rejections.push({ ...label, reason: 'kami not present at replay basis' });
    return;
  }
  const basisKami = materialize(basisMirror, basisEntity, shot.capturedAtMs - 66_000);
  const basisMarkers = actionMarkers(basisKami);

  // Rate strings: the client renders both (+MUSU/hr, −HP/hr) together at
  // some instant τ within its lawful staleness window — the party modal's
  // description refreshes every ≤60 s (StatusDisplay tick) over a kami
  // object refreshed on ≤5 s TTLs (Party.tsx kamiRefreshOptions), and both
  // spot intensity (minute-floored) and temp-bonus expiries move the value
  // inside that window. So: sweep τ over [capture − 65 s, capture] at 1 s
  // granularity (ascending — the cache TTL maps demand increasing frozen
  // times) and require ONE τ to match BOTH displayed rate strings. The
  // matching τ offset is recorded; the final step (τ = capture) is the kami
  // used for every other field.
  const p = kind === 'party' ? (row as PartyRow) : undefined;
  const wantsRates = p?.musuRatePerHr !== undefined || p?.hpRatePerHr !== undefined;
  let rateTauOffsetSec: number | undefined;
  let kami!: ReturnType<typeof getKami>;
  for (let off = wantsRates ? 65 : 0; off >= 0; off--) {
    kami = materialize(mirror, entity, shot.capturedAtMs - off * 1000);
    if (wantsRates && rateTauOffsetSec === undefined) {
      const musuOk =
        p!.musuRatePerHr === undefined ||
        getRateDisplay(kami.harvest?.rates.total.spot, 2) === p!.musuRatePerHr;
      const hpOk =
        p!.hpRatePerHr === undefined ||
        getRateDisplay(kami.stats?.health.rate, 2) === p!.hpRatePerHr;
      if (musuOk && hpOk) rateTauOffsetSec = off;
    }
    if (off > 0) KamiCache.clear();
  }
  const obsMarkers = actionMarkers(kami);
  const changed = Object.keys(basisMarkers).filter(
    (k) => !Object.is(basisMarkers[k], obsMarkers[k])
  );
  if (changed.length > 0) {
    rejections.push({
      ...label,
      reason: 'on-chain action between replay basis and observation block',
      changedMarkers: changed,
      basis: Object.fromEntries(changed.map((k) => [k, basisMarkers[k]])),
      observation: Object.fromEntries(changed.map((k) => [k, obsMarkers[k]])),
    });
    return;
  }

  const result: Record<string, unknown> = { ...label };
  let ok = true;

  // hp
  const hp = calcHealth(kami);
  const total = kami.stats?.health.total ?? 0;
  const dHp = hp - row.hp.current;
  deltas.hp.push(dHp);
  const hpOk = Math.abs(dHp) <= 2 && total === row.hp.total;
  result.hp = { ours: `${hp}/${total}`, displayed: `${row.hp.current}/${row.hp.total}`, delta: dHp, ok: hpOk };
  if (!hpOk) ok = false;
  if (row.hp.percent !== undefined) {
    const pct = total === 0 ? 0 : Number(((100 * hp) / total).toFixed(0));
    const pctOk = Math.abs(pct - row.hp.percent) <= 2;
    result.hpPercent = { ours: pct, displayed: row.hp.percent, ok: pctOk };
    if (!pctOk) ok = false;
  }

  // state token (party rows carry the header text)
  if (kind === 'party') {
    const displayedToken = (row as PartyRow).stateText.split(' while ')[0];
    const token = stateToken(kami);
    const stateOk = token === displayedToken;
    result.state = { ours: token, displayed: displayedToken, ok: stateOk };
    if (!stateOk) ok = false;

    const p = row as PartyRow;
    if (p.nodeName !== undefined) {
      const nodeName = kami.harvest?.node?.name;
      const nodeOk = nodeName === p.nodeName;
      result.node = { ours: nodeName, displayed: p.nodeName, ok: nodeOk };
      if (!nodeOk) ok = false;
    }
    if (wantsRates) {
      const rateOk = rateTauOffsetSec !== undefined;
      const rates = {
        oursAtCapture: {
          musu: getRateDisplay(kami.harvest?.rates.total.spot, 2),
          hp: getRateDisplay(kami.stats?.health.rate, 2),
        },
        displayed: { musu: p!.musuRatePerHr, hp: p!.hpRatePerHr },
        matchedAtSecondsBeforeCapture: rateTauOffsetSec,
        ok: rateOk,
      };
      result.rates = rates;
      if (!rateOk) ok = false;
    }
  }

  // musu accrued
  if (row.musuAccrued !== undefined) {
    const musu = calcOutput(kami);
    const dMusu = musu - row.musuAccrued;
    deltas.musu.push(dMusu);
    const musuOk = Math.abs(dMusu) <= 2;
    result.musu = { ours: musu, displayed: row.musuAccrued, delta: dMusu, ok: musuOk };
    if (!musuOk) ok = false;
  }

  // cooldown
  {
    const c = calcCooldown(kami);
    const displayed = row.cooldown === 'ready' ? 0 : Number(row.cooldown.replace(/s$/, ''));
    const oursSec = Math.max(0, Math.floor(c));
    const dCd = oursSec - displayed;
    deltas.cooldown.push(dCd);
    const cdOk = Math.abs(dCd) <= 2;
    result.cooldown = { ours: oursSec, displayed, delta: dCd, ok: cdOk };
    if (!cdOk) ok = false;
  }

  // owner (enemy rows)
  if (kind === 'enemy') {
    const owner = getKamiAccount(mirror.world, mirror.components, entity as never);
    const ownerOk = owner.name === (row as EnemyRow).ownerName;
    result.owner = { ours: owner.name, displayed: (row as EnemyRow).ownerName, ok: ownerOk };
    if (!ownerOk) ok = false;
  }

  if (row.uncertain?.length) result.uncertainFields = row.uncertain;
  result.ok = ok;
  if (!ok) failures++;
  if (kami.index) kamisCompared.add(kami.index);
  rows.push(result);
}

const inventoryResults: Record<string, unknown>[] = [];
function compareInventory(shot: Screenshot): void {
  const inv = shot.views.inventory!;
  const party = shot.views.party ?? [];
  if (party.length === 0) {
    inventoryResults.push({ screenshot: shot.file, error: 'no party rows to identify the account', ok: false });
    failures++;
    return;
  }
  const obsBlock = obsBlocks.get(shot.file)!;
  const mirror = obsMirrors.get(obsBlock)!;

  KamiCache.clear();
  const entity = resolveEntity(mirror, party[0]);
  if (entity === undefined) {
    inventoryResults.push({ screenshot: shot.file, error: 'account-anchor kami not found', ok: false });
    failures++;
    return;
  }
  Date.now = () => shot.capturedAtMs;
  clock.reset();
  let account;
  try {
    account = getKamiAccount(mirror.world, mirror.components, entity as never, { inventory: 0 });
  } finally {
    Date.now = realNow;
  }
  const inventories = account.inventories ?? [];
  accountsSeen.add(account.name);

  // The grid = cleanInventories minus MUSU. Upstream quirk on the record:
  // cleanInventories' comment says "removes MUSU" but its code does not —
  // the removal actually lives in the Inventory modal's items grid component
  // (filter on MUSU_INDEX), so the machine-side render formula applies both.
  const cleaned = cleanInventories(inventories).filter((i) => i.item.index !== MUSU_INDEX);
  const oursCounts = cleaned.map((i) => i.balance);
  const oursBalance = getInventoryBalance(inventories, MUSU_INDEX);

  const balanceOk = oursBalance === inv.musuBalance;
  // Strict count comparison; transcription-illegible cells/grids are
  // excluded (never corrected toward the mirror) and logged.
  let countsOk: boolean;
  let countsSkipped: string | undefined;
  const uncertain = new Set(inv.uncertainCells);
  const n = inv.countsInGridOrder.length;
  if (inv.gridIllegible) {
    countsOk = true;
    countsSkipped = 'grid transcription illegible at capture resolution — counts excluded, balance still strict';
  } else if (inv.complete) {
    countsOk =
      oursCounts.length === n &&
      oursCounts.every((c, i) => uncertain.has(i) || c === inv.countsInGridOrder[i]);
  } else {
    countsOk =
      oursCounts.length >= n &&
      inv.countsInGridOrder.every((c, i) => uncertain.has(i) || c === oursCounts[i]);
  }
  const ok = balanceOk && countsOk;
  if (!ok) failures++;
  inventoryResults.push({
    screenshot: shot.file,
    account: account.name,
    balance: { ours: oursBalance, displayed: inv.musuBalance, ok: balanceOk },
    counts: {
      ours: oursCounts,
      displayed: inv.countsInGridOrder,
      complete: inv.complete,
      uncertainCells: inv.uncertainCells,
      skipped: countsSkipped,
      ok: countsOk,
    },
    ok,
  });
}

for (const shot of fixture.screenshots) {
  for (const row of shot.views.party ?? []) compareRow(shot, row, 'party');
  for (const row of shot.views.roomEnemies?.rows ?? []) compareRow(shot, row, 'enemy');
  if (shot.views.inventory) compareInventory(shot);
}

// --- 4. zero-bias check ------------------------------------------------------
const bias: Record<string, unknown> = {};
let biased = false;
for (const [field, ds] of Object.entries(deltas)) {
  const nonzero = ds.filter((d) => d !== 0);
  const pos = nonzero.filter((d) => d > 0).length;
  const neg = nonzero.filter((d) => d < 0).length;
  const oneSided = nonzero.length >= 4 && (pos === 0 || neg === 0);
  bias[field] = { deltas: ds, nonzero: nonzero.length, positive: pos, negative: neg, oneSided };
  if (oneSided) biased = true;
}

// --- 5. coverage + verdict ---------------------------------------------------
const roomViews = fixture.screenshots.filter((s) => s.views.roomEnemies).length;
const inventoryPanels = fixture.screenshots.filter((s) => s.views.inventory).length;
const coverage = {
  distinctKamis: kamisCompared.size,
  accounts: [...accountsSeen],
  roomViews,
  inventoryPanels,
  rejections: rejections.length,
  skips: skips.length,
};
const coverageOk =
  kamisCompared.size >= 10 && accountsSeen.size >= 2 && roomViews >= 1 && inventoryPanels >= 1;

await writeMeasurement('g2b-display-parity', {
  mode: 'screenshot-transcription',
  snapshotBasisBlock: baseCache.blockNumber,
  observationBlocks: Object.fromEntries(obsBlocks),
  rowsCompared: rows.length,
  failures,
  rejections,
  skips,
  rows,
  inventory: inventoryResults,
  zeroBias: bias,
  coverage,
  match: failures === 0 && !biased && coverageOk,
});

if (!coverageOk) {
  fail('G2.b', { reason: 'coverage shortfall', coverage });
}
if (biased) {
  fail('G2.b', { reason: 'zero-bias check failed — consistent one-sided error inside tolerance', bias });
}
if (failures > 0) {
  fail('G2.b', {
    reason: 'display parity mismatch',
    failures,
    rows: rows.filter((r) => !r.ok),
    inventory: inventoryResults.filter((r) => !r.ok),
  });
}
pass('G2.b', {
  rowsCompared: rows.length,
  coverage,
  zeroBiasClean: !biased,
});
process.exit(0);
