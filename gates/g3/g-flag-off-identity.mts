// Gate G3.g [hermetic] — flag-off identity. The enrichment flag (`enrich`,
// default off) must be a NO-OP: with the flag off every query answers
// byte-for-byte what the REFERENCE TREE answered at the same block.
//
// 0.5.0 RE-BASES THE REFERENCE, and the restatement is deliberate rather
// than a renumbering. At 0.4.0 the reference was a 0.3.0 checkout, and the
// claim "flag-off is byte-identical to 0.3.0" was a claim ACROSS versions —
// which 0.5.0 cannot make and does not: it changes default answers on
// purpose (§3.13). The reference is now 0.5.0's own flag-off surface, so
// what this gate proves is that the flag adds fields and removes none
// against THIS release's defaults, and — from the moment these baselines are
// frozen — that no later change to 0.5.x moves a default answer without
// someone re-capturing them on purpose. Its value is as a frozen baseline
// for what comes next, not as a cross-version identity proof; the SPEC row
// says so in those words.
//
// The `status` exception changes shape with the re-basing: at 0.4.0 status
// GAINED two provenance keys against a tree that lacked them, and at 0.5.0
// both sides have them, so status must add nothing at all while still
// carrying them at their default values.
//
// The clock mask is DERIVED, not hand-listed: it is the union of the pairwise
// differences across every baseline capture taken from the REFERENCE tree
// (0.3.0). Any leaf that differs between two runs of identical code is
// clock-derived by construction — GDA prices, phase countdowns, vendor
// rotation, accruing vitals, daemon timestamps — and is excluded from the
// value comparison. Everything else must match exactly, and the KEY SET must
// match exactly in every case, which is what catches an accidentally
// unconditional field, a reordered object, or a stray addition.
//
//   tsx gates/g3/g-flag-off-identity.mts --capture base1   (reference tree)
//   tsx gates/g3/g-flag-off-identity.mts --capture base2   (reference tree)
//   tsx gates/g3/g-flag-off-identity.mts --capture base3   (reference tree,
//                                        alongside the verify run)
//   tsx gates/g3/g-flag-off-identity.mts                   (verify)
//
// THE MASK IS DERIVED BY PERTURBING THE CLOCK, which is what makes it
// trustworthy rather than lucky. Every capture pins the §3.8 clock
// (CLOCK_PIN_SEC, optionally shifted by --pin-offset), and the baselines are
// taken at DIFFERENT pins: a leaf whose value depends on the clock at all
// then differs between them by construction and is masked, while a leaf that
// depends only on the code is unaffected by the shift and must match exactly.
//
// Two earlier designs failed here, and both failures are on the record in
// the measurements: a mask derived from two same-instant runs missed
// piecewise-constant values (`auctions[0].price` 4660 → 4650,
// `phase.cycleHour` 17 → 18 — identical in both baselines, different hours
// later), and a pin alone cannot align continuous-time values either,
// because pinning offsets the clock without stopping it, so a GDA price read
// two seconds into one run and three into another still differs. Perturbing
// the pin catches both classes.
//
// Baselines therefore need no special ordering — take them from a checkout of
// the reference release at any time (a git worktree sharing this repo's
// gates/.artifacts). The verify run compares against the baseline that shares
// its OWN pin; the other baseline exists to move the clock:
//
//   git worktree add --detach <dir> <reference-tag>
//   (cd <dir> && tsx gates/g3/g-flag-off-identity.mts --capture base1)
//   (cd <dir> && tsx gates/g3/g-flag-off-identity.mts --capture base2 \
//                     --pin-offset 86400)
//
// Refuse-and-report, never a silent wrong-state comparison: fewer than two
// baselines, no baseline at the verify run's own pin, a baseline at a
// different snapshot block, or a key-set difference BETWEEN baselines
// (nondeterminism rather than clock dependence) fails the gate instead of
// being masked away.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import * as clock from '../../src/clock';
import { resolveConfig } from '../../src/config';
import { KamiLensDaemon } from '../../src/daemon';
import { getVersionInfo } from '../../src/version';
import { buildEnvelope, serveQuery } from '../../src/queries';
import { loadSchema } from '../../src/queries/registry';
import { buildStatusData } from '../../src/server';
import { query as queryKamis } from '../../src/network/shapes/Kami/queries';
import { getKamiIndex } from '../../src/network/shapes/utils/component';
import {
  ARTIFACTS_DIR,
  fail,
  loadCacheFromSnapshotFile,
  pass,
  writeMeasurement,
} from '../g1/lib.mts';
import { buildMirror } from '../g2/lib.mts';

/** The provenance keys that make the enrichment flag visible (DESIGN §5).
 *
 * 0.4.0 asserted these as keys `status` ADDED, because its baseline came from
 * a 0.3.0 checkout that did not have them. At 0.5.0 the baseline is this
 * release's own flag-off answer, so they are present on BOTH sides and
 * nothing is added at all — which is the honest form of the claim from here
 * on, and the reason the SPEC row is restated rather than renumbered. What is
 * still asserted, and is what the keys are for, is that they are PRESENT and
 * carry their default values in a flag-off answer: a switch you can only see
 * when it is on is not provenance. */
const STATUS_FLAG_KEYS = ['config.enrich', 'configSources.enrich'];

/** …and by exactly this VALUE: `status` reports the package version, so it
 * differs at every release. Asserted rather than masked — it must equal the
 * version this build actually carries. */
const STATUS_EXPECTED_CHANGED = 'version';

/** 0.5.2 ADDITIVE LEAVES — the named allowance.
 *
 * The baselines stay FROZEN. 0.5.2 adds fields to answers that carry a
 * projection, and this gate's whole job is to fail when a flag-off answer
 * changes shape, so the release either re-captures the baselines or names
 * what it added. Naming it is strictly stronger: a re-capture would also
 * absorb any change nobody intended, while this list is reviewable, and
 * anything NOT on it still fails. Same mechanism as STATUS_FLAG_KEYS above.
 *
 * Each entry is a leaf PATH PREFIX, matched against a `leaves()` path, per
 * case key. Values are not asserted here — the point of the release is that
 * these are new facts, and their correctness is G3.a's and G2.b's job.
 *
 * - `cooldownUntil` (§3.8): the raw on-chain cooldown end time, beside the
 *   projected `cooldownSec`. Unconditional, so it lands on every answer that
 *   projects a kami.
 * - `margin` (§3.13): threshold minus projected hp on a liquidation preview.
 *   Reaches only the case that passes an attacker.
 * - `feedsDegraded` (§1.2): the Kamiden counterpart of `degraded` on
 *   `status`. NOTE its value on this gate's UNSTARTED daemon: the supervisor
 *   is constructed with a URL but never started, so the stream state is
 *   'stopped' and the array reads ["kamiden-stream:stopped"] — the leaf is
 *   `feedsDegraded[0]`, not `feedsDegraded[]`. That is correct: a stream
 *   that was never opened is not a healthy one.
 *
 * NOT covered, deliberately: `harvestsEligible` and the `--slim` account
 * fields are flag-gated and cannot appear in a flag-off answer at all, and
 * `meta.asOf` is on the ENVELOPE, which this gate never captures (it
 * compares `env.data`). Removals are never allowed by this list — the
 * duplicate-exit defect on `room` would REMOVE leaves, so it is recorded in
 * SPEC as a known defect for 0.5.3 rather than fixed here.
 *
 * 0.5.3 adds ONE leaf, on the same terms:
 * - `blocked` (§3.8/§3.13): the attacker's own liquidation gate, on the
 *   `attacker` object of a node answer. It reaches exactly the case that
 *   passes an attacker (`node+attacker`), and it is present there
 *   unconditionally — with or without `--eligible-only` — which is the whole
 *   point of the field: "can I act at all?" must not be answerable only by
 *   reading an empty filtered list. Declared here rather than re-capturing
 *   the baselines, exactly as 0.5.2's three were. NOTE the baselines'
 *   `node+attacker` case runs against a STARVING attacker (kami 2 in the
 *   fixture, all 41 rows `reason: ATTACKER_STARVING`), so this leaf lands
 *   with a non-null value there — an added leaf's VALUE is not compared, and
 *   its correctness is G7.c's job, not this gate's. */
const ADDITIVE_LEAVES_052 = ['cooldownUntil', 'margin', 'feedsDegraded'];
const ADDITIVE_LEAVES_053 = ['blocked'];

/** 0.6.0 adds one BLOCK, on the same terms as the leaves above.
 *
 * `status.sync` (§3.17): the sync layer's own recovery health. It lands on
 * `status` unconditionally — including on this gate's UNSTARTED daemon,
 * where the counters are all zero, `reconciledThrough` and `lastReconcileAt`
 * are null and `unhealedRanges` is empty, so its leaf is `sync.unhealedRanges[]`
 * (leaves() renders an empty array that way). The matcher below strips ONE
 * trailing `[n]`/`[]` from the last dot-segment, which is exactly enough for
 * that leaf; a NON-empty list would render `sync.unhealedRanges[0][1]` and
 * would not match — irrelevant on an unstarted daemon, recorded here so the
 * next release does not discover it as a surprise.
 *
 * Declared rather than re-capturing the baselines, exactly as 0.5.2's three
 * and 0.5.3's one were: a re-capture would also absorb any change nobody
 * intended, while this list is reviewable and anything NOT on it still
 * fails. */
const ADDITIVE_LEAVES_060 = [
  'reconnects',
  'gapsHealed',
  'gapsDeferred',
  'reconcilePasses',
  'reconciledThrough',
  'lastReconcileAt',
  'unhealedRanges',
  'lastHealMs',
  'reconcileIntervalMs',
];

/** 0.6.2 adds TWO leaves, on the same terms.
 *
 * - `lastFullLoad` (§3.1): which source served this process's full state
 *   load. On this gate's UNSTARTED daemon no load has run, so the value is
 *   null and `leaves()` renders the leaf as `lastFullLoad` itself — which is
 *   why only the block name is listed and not its six inner keys. Listing
 *   those would be worse than useless here: `source`, `block`, `nonce`, `at`
 *   and `seconds` are generic enough that an entry for each would mask a
 *   removal somewhere else in the tree, which is exactly what this list must
 *   not do. A future release that captures baselines against a STARTED daemon
 *   will see `lastFullLoad.source` and friends and has to say so then.
 * - `stateCdnUrl` (§3.1): the config key, which lands on BOTH `config` and
 *   `configSources` (configSources is keyed by every config field, so a new
 *   field always adds a leaf there). One entry covers both, because the
 *   matcher below resolves a path to its last dot-segment.
 *
 * Declared rather than re-capturing the baselines, for the same reason every
 * list above was: a re-capture absorbs changes nobody intended, and anything
 * NOT on these lists still fails. */
const ADDITIVE_LEAVES_062 = ['lastFullLoad', 'stateCdnUrl'];
// 0.6.3: `checkpoint.inFlight` (the checkpoint moved off the main thread,
// so "is one being written" became answerable) and `lastFullLoad.kind`
// (a warm boot's delta read as a full load).
const ADDITIVE_LEAVES_063 = ['inFlight', 'kind'];

/** Does a leaf path belong to a 0.5.2 additive field? Matches the last
 * dot-segment (array indices stripped), so `kamis[3].cooldownUntil` and
 * `harvests[0].vitals.cooldownUntil` both resolve to `cooldownUntil`. */
function isAdditive052(path: string): boolean {
  const leaf = (path.split('.').pop() ?? '').replace(/\[\d*\]$/, '');
  return (
    ADDITIVE_LEAVES_052.includes(leaf) ||
    ADDITIVE_LEAVES_053.includes(leaf) ||
    ADDITIVE_LEAVES_060.includes(leaf) ||
    ADDITIVE_LEAVES_062.includes(leaf) ||
    ADDITIVE_LEAVES_063.includes(leaf)
  );
}

/** Pinned instant for the §3.8 clock. The verify run and its reference
 * baseline share it; the other baseline is taken at a shifted pin so the mask
 * catches everything the clock touches. Any fixed value works; this one is
 * inside the fixture's own era. */
const CLOCK_PIN_SEC = 1_755_000_000;

const pinOffsetSec = (() => {
  const i = process.argv.indexOf('--pin-offset');
  return i >= 0 ? Number(process.argv[i + 1]) : 0;
})();
const clockPinSec = CLOCK_PIN_SEC + pinOffsetSec;

const captureLabel = (() => {
  const i = process.argv.indexOf('--capture');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const config = resolveConfig();
const cache = await loadCacheFromSnapshotFile(path.join(ARTIFACTS_DIR, 'c2.v8snap'), config);
const { world, components } = buildMirror(cache);
const mirror = { world, components, blockNumber: cache.blockNumber };

// --- deterministic sample set (same selection rule as G3.f) -----------------
const kamiIndexes = queryKamis(components)
  .slice(0, 50)
  .map((e) => getKamiIndex(components, e))
  .filter((i) => i > 0);
let firstKami = '';
let anAccount = 0;
for (const idx of kamiIndexes) {
  const data = (await serveQuery(mirror, 'kami', [String(idx)], { stale: false, mode: 'daemon' }))
    .data as { account?: { index: number } };
  if (data.account?.index) {
    firstKami = String(idx);
    anAccount = data.account.index;
    break;
  }
}
if (!anAccount) fail('G3.g', { reason: 'no sampled kami with an owning account' });
const accountRoom = (
  (await serveQuery(mirror, 'account', [String(anAccount)], { stale: false, mode: 'daemon' }))
    .data as { roomIndex: number }
).roomIndex;

type Case = { key: string; query: string; args: string[]; opts?: Record<string, unknown> };
const CASES: Case[] = [
  { key: 'kami', query: 'kami', args: [firstKami] },
  { key: 'account', query: 'account', args: [String(anAccount)] },
  { key: 'account+prose', query: 'account', args: [String(anAccount)], opts: { prose: true } },
  { key: 'party', query: 'party', args: [String(anAccount)] },
  { key: 'roster', query: 'roster', args: [String(anAccount)] },
  {
    key: 'roster+nameFree',
    query: 'roster',
    args: [String(anAccount)],
    opts: { noAuthored: true },
  },
  { key: 'inventory', query: 'inventory', args: [String(anAccount)] },
  { key: 'item', query: 'item', args: ['1'] },
  { key: 'items', query: 'items', args: [] },
  { key: 'quests', query: 'quests', args: [] },
  { key: 'quests+account', query: 'quests', args: [String(anAccount)] },
  { key: 'trades', query: 'trades', args: [] },
  { key: 'auctions', query: 'auctions', args: [] },
  { key: 'merchant', query: 'merchant', args: [] },
  { key: 'merchant+1', query: 'merchant', args: ['1'] },
  { key: 'merchant+2', query: 'merchant', args: ['2'] },
  { key: 'room', query: 'room', args: [String(accountRoom)] },
  { key: 'node', query: 'node', args: ['62'] },
  { key: 'node+vitals', query: 'node', args: ['62', '--with-vitals'] },
  { key: 'node+attacker', query: 'node', args: ['62', firstKami, '--with-vitals'] },
  { key: 'config', query: 'config', args: ['KAMI_STANDARD_COOLDOWN'] },
  { key: 'phase', query: 'phase', args: [] },
  { key: 'leaderboard', query: 'leaderboard', args: [] },
  { key: 'leaderboard+liq', query: 'leaderboard', args: ['LIQUIDATE', '1', '0'] },
  // 0.5.0 (§3.13): the uncompacted forms and the new views are part of the
  // frozen surface too — a `--full` answer that quietly changed would be as
  // much of a break as a default one, and the enrichment flag must be a
  // no-op on every one of them.
  { key: 'quests+full', query: 'quests', args: ['--full'] },
  { key: 'quests+account+full', query: 'quests', args: [String(anAccount), '--full'] },
  { key: 'quests+account+open', query: 'quests', args: [String(anAccount), '--open'] },
  { key: 'quests+account+accepted', query: 'quests', args: [String(anAccount), '--accepted'] },
  { key: 'quests+keyed', query: 'quests', args: [String(anAccount), '1'] },
  { key: 'items+full', query: 'items', args: ['--full'] },
  { key: 'items+type', query: 'items', args: ['FOOD'] },
  { key: 'skills', query: 'skills', args: [] },
  { key: 'skills+kami', query: 'skills', args: [firstKami] },
  { key: 'party+full', query: 'party', args: [String(anAccount), '--full'] },
  { key: 'room+full', query: 'room', args: [String(accountRoom), '--full'] },
  { key: 'node+vitals+full', query: 'node', args: ['62', '--with-vitals', '--full'] },
  { key: 'merchant+1+full', query: 'merchant', args: ['1', '--full'] },
  { key: 'leaderboard+full', query: 'leaderboard', args: ['--full'] },
  { key: 'trades+full', query: 'trades', args: ['--full'] },
];

/** Flatten to leaf paths, array indices included — an added, moved, or
 * renamed field is a key-set difference, not a value difference.
 *
 * Always fed the JSON WIRE FORM, never a live object. Builders assign some
 * optional fields unconditionally (`level: kami.progress?.level`), so a key
 * whose value is `undefined` exists in memory and vanishes on serialization;
 * comparing a live capture against a serialized baseline reported those as
 * added fields. Identity is a property of what goes over the socket, so both
 * sides are normalized through JSON. (Found by this gate's own second run.) */
function leaves(value: unknown, at = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (Array.isArray(value)) {
    if (value.length === 0) out[`${at}[]`] = '<empty array>';
    value.forEach((v, i) => leaves(v, `${at}[${i}]`, out));
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) out[`${at}{}`] = '<empty object>';
    for (const [k, v] of entries) leaves(v, at ? `${at}.${k}` : k, out);
    return out;
  }
  out[at] = value as never;
  return out;
}

type Capture = {
  snapshotBlock: number;
  clockPinSec: number;
  cases: Record<string, Record<string, unknown>>;
};

const wire = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

async function capture(): Promise<Capture> {
  // pin the clock BEFORE any projection read (see the header note)
  clock.observeBlockTimestamp(clockPinSec);
  const cases: Record<string, Record<string, unknown>> = {};
  for (const c of CASES) {
    const env = await serveQuery(mirror, c.query, c.args, {
      ...c.opts,
      stale: false,
      mode: 'daemon',
    });
    cases[c.key] = leaves(wire(env.data));
  }
  // status: served by the daemon itself, on an unstarted daemon (its shape is
  // state-independent — the G3.a pattern). The data dir is a FIXED LITERAL,
  // not a path under this checkout: status echoes it, and a worktree-relative
  // path would differ between the reference capture and the verify run for a
  // reason that has nothing to do with the code under test.
  const daemon = new KamiLensDaemon({ dataDir: '/nonexistent/kami-lens-g3g-void' });
  const env = buildEnvelope(
    buildStatusData(daemon),
    loadSchema('status'),
    { blockNumber: 0, stale: true, mode: 'daemon' },
    {}
  );
  cases['status'] = leaves(wire(env.data));
  return { snapshotBlock: cache.blockNumber, clockPinSec, cases };
}

const filePath = (label: string) => path.join(ARTIFACTS_DIR, `kd-flagoff-${label}.json`);

const now = await capture();

if (captureLabel) {
  writeFileSync(filePath(captureLabel), JSON.stringify(now));
  const total = Object.values(now.cases).reduce((n, c) => n + Object.keys(c).length, 0);
  console.log(
    `G3.g capture '${captureLabel}' written: ${CASES.length + 1} cases, ${total} leaves, ` +
      `block ${now.snapshotBlock}, clock pin ${now.clockPinSec}`
  );
  process.exit(0);
}

// --- verify -----------------------------------------------------------------
const BASELINE_LABELS = ['base1', 'base2', 'base3'];
const present_ = BASELINE_LABELS.filter((l) => existsSync(filePath(l)));
if (present_.length < 2) {
  fail('G3.g', {
    reason: 'fewer than two baseline captures — take them from the reference tree with --capture',
    found: present_,
    expected: BASELINE_LABELS.map(filePath),
  });
}
const baselines = present_.map((l) => ({
  label: l,
  capture: JSON.parse(readFileSync(filePath(l), 'utf8')) as Capture,
}));
for (const b of baselines) {
  if (b.capture.snapshotBlock !== now.snapshotBlock) {
    fail('G3.g', {
      reason: 'snapshot block moved between captures — re-capture the baselines',
      baseline: b.label,
      baselineBlock: b.capture.snapshotBlock,
      now: now.snapshotBlock,
    });
  }
}
// the comparison target is the baseline sharing this run's clock pin; the
// others move the clock and so define the mask
const reference = baselines.find((b) => b.capture.clockPinSec === clockPinSec);
if (!reference) {
  fail('G3.g', {
    reason: 'no baseline was captured at this run\'s clock pin',
    pin: clockPinSec,
    baselinePins: baselines.map((b) => ({ [b.label]: b.capture.clockPinSec ?? null })),
  });
}
if (!baselines.some((b) => b.capture.clockPinSec !== clockPinSec)) {
  fail('G3.g', {
    reason: 'every baseline shares one clock pin — the mask cannot separate clock from code; capture one with --pin-offset',
    baselinePins: baselines.map((b) => ({ [b.label]: b.capture.clockPinSec ?? null })),
  });
}
const base1 = reference.capture;

const problems: Record<string, unknown>[] = [];
const report: Record<string, unknown>[] = [];
let maskedTotal = 0;
let comparedTotal = 0;
const maskedSamples: string[] = [];

for (const key of Object.keys(base1.cases)) {
  const b1 = base1.cases[key];
  const n = now.cases[key] ?? {};
  const others = baselines.filter((b) => b !== reference).map((b) => b.capture.cases[key] ?? {});

  // every baseline must agree on SHAPE — a key-set difference there means the
  // capture is nondeterministic, which no mask may paper over
  const b1Keys = Object.keys(b1).sort();
  let shapeStable = true;
  for (const o of others) {
    if (JSON.stringify(Object.keys(o).sort()) !== JSON.stringify(b1Keys)) shapeStable = false;
  }
  if (!shapeStable) {
    problems.push({ case: key, reason: 'baseline captures disagree on key set (nondeterministic)' });
    continue;
  }

  // mask = union of every pairwise disagreement among the baselines
  const mask = b1Keys.filter((p) =>
    others.some((o) => JSON.stringify(b1[p]) !== JSON.stringify(o[p]))
  );
  maskedTotal += mask.length;
  if (maskedSamples.length < 25) maskedSamples.push(...mask.slice(0, 25 - maskedSamples.length).map((p) => `${key}:${p}`));
  const maskSet = new Set<string>(mask);

  const nowKeys = new Set(Object.keys(n));
  const added = [...nowKeys].filter((p) => !(p in b1)).sort();
  const removed = b1Keys.filter((p) => !nowKeys.has(p));

  // 0.5.2: leaves the release declares as additive are allowed to appear,
  // and ONLY those. Everything else still fails, in both directions.
  const unexpectedAdded = added.filter((p) => !isAdditive052(p));
  const allowedAdded = added.filter((p) => isAdditive052(p));

  if (key === 'status') {
    // the baseline is this release's own answer, so status must add nothing
    // beyond the declared 0.5.2 additive leaves
    if (unexpectedAdded.length > 0) {
      problems.push({
        case: key,
        reason: 'status gained fields against its own baseline',
        added: unexpectedAdded,
      });
    }
    for (const flagKey of STATUS_FLAG_KEYS) {
      if (!(flagKey in n)) {
        problems.push({ case: key, reason: 'a flag provenance key is missing from status', missing: flagKey });
      }
    }
    if (n['config.enrich'] !== false || n['configSources.enrich'] !== 'default') {
      problems.push({
        case: key,
        reason: 'status flag keys have unexpected default values',
        enrich: n['config.enrich'],
        source: n['configSources.enrich'],
      });
    }
    // the release string: asserted against the build, not masked away
    const builtVersion = getVersionInfo().version;
    if (n[STATUS_EXPECTED_CHANGED] !== builtVersion) {
      problems.push({
        case: key,
        reason: 'status version does not match the built package version',
        served: n[STATUS_EXPECTED_CHANGED],
        built: builtVersion,
      });
    }
    maskSet.add(STATUS_EXPECTED_CHANGED);
  } else if (unexpectedAdded.length > 0) {
    problems.push({
      case: key,
      reason: 'flag-off answer gained fields',
      added: unexpectedAdded.slice(0, 20),
    });
  }
  if (removed.length > 0) {
    problems.push({ case: key, reason: 'flag-off answer lost fields', removed: removed.slice(0, 20) });
  }

  let mismatches = 0;
  const samples: Record<string, unknown>[] = [];
  for (const p of b1Keys) {
    if (maskSet.has(p) || !nowKeys.has(p)) continue;
    comparedTotal++;
    if (JSON.stringify(b1[p]) !== JSON.stringify(n[p])) {
      mismatches++;
      if (samples.length < 5) samples.push({ path: p, was: b1[p], now: n[p] });
    }
  }
  if (mismatches > 0) {
    problems.push({ case: key, reason: 'flag-off value changed', mismatches, samples });
  }
  report.push({
    case: key,
    leaves: b1Keys.length,
    masked: mask.length,
    compared: b1Keys.length - mask.length,
    added: unexpectedAdded.length,
    additive052: allowedAdded.length,
    removed: removed.length,
    mismatches,
  });
}

await writeMeasurement('g3g-flag-off-identity', {
  snapshotBlock: now.snapshotBlock,
  clockPinSec,
  baselines: baselines.map((b) => ({ label: b.label, clockPinSec: b.capture.clockPinSec ?? null })),
  comparedAgainst: reference.label,
  statusExpectedChanged: { path: STATUS_EXPECTED_CHANGED, to: getVersionInfo().version },
  cases: report,
  leavesCompared: comparedTotal,
  leavesMasked: maskedTotal,
  maskedSamples,
  statusFlagKeys: STATUS_FLAG_KEYS,
  problems,
  match: problems.length === 0 && comparedTotal > 5000,
});

if (problems.length > 0 || comparedTotal <= 5000) {
  fail('G3.g', { reason: 'flag-off identity broken', problems: problems.slice(0, 10), comparedTotal });
}
pass('G3.g', { cases: report.length, compared: comparedTotal, masked: maskedTotal });
process.exit(0);
