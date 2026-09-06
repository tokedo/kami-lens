// Gate G7.c [hermetic] — the two 0.5.2 payload flags, over one snapshot
// mirror (DESIGN §3.13).
//
// Both flags exist to make an answer SMALLER, and the only interesting
// question about a smaller answer is whether anything went missing that was
// not supposed to. Neither is checked by its payload number: a filter that
// dropped the wrong rows, or an identity view that served a stale name,
// would look like a bigger saving. So both are checked by EQUALITY against
// the answer they claim to be a subset of, at the SAME BLOCK — which is why
// this is hermetic and not live. Two independently streaming daemons cannot
// agree on a projected HP, and a live world moves under a two-call
// comparison; one snapshot mirror makes "same block" exact rather than
// approximate.
//
//   · node --eligible-only: the filtered rows are BYTE-EQUAL to a
//     client-side filter of the unfiltered --full answer, on every sampled
//     node — the exact operation a caller performs today, and the one the
//     flag is meant to replace. harvestsTotal must still report the whole
//     node, and harvestsEligible must equal the filtered count.
//   · node --eligible-only with a BLOCKED attacker (0.5.3): the filter is
//     target-side, so a starving or cooling attacker still gets the list of
//     targets in reach, each row keeping its full-pairing `eligible: false`
//     and its `reason`, with the attacker's own gate reported once on
//     `attacker.blocked`. The rows 0.5.2's predicate would have served — 0,
//     on a node with targets — are recorded beside them. The cooling half of
//     that enum is NOT covered here and says so in the record: see the note
//     below the starving section for what was measured and why it was
//     dropped rather than shipped.
//   · account --slim: every field the slim answer serves is byte-equal to
//     the same field of the full answer, and kamisTotal equals the full
//     roster's length. The absences are asserted too — a slim answer that
//     quietly kept the roster would pass a field-equality check trivially.
//
// Payload before/after is RECORDED, not asserted: the saving is a
// consequence, and freezing a threshold on fixture occupancy would fail for
// reasons that have nothing to do with the code.

import path from 'node:path';

import { resolveConfig } from '../../src/config';
import { serveQuery } from '../../src/queries';
import { query as queryKamis } from '../../src/network/shapes/Kami/queries';
import { getKamiIndex } from '../../src/network/shapes/utils/component';
import { ARTIFACTS_DIR, fail, loadCacheFromSnapshotFile, pass, writeMeasurement } from '../g1/lib.mts';
import { buildMirror } from '../g2/lib.mts';

const config = resolveConfig();
const cache = await loadCacheFromSnapshotFile(path.join(ARTIFACTS_DIR, 'c2.v8snap'), config);
const { world, components } = buildMirror(cache);
const mirror = { world, components, blockNumber: cache.blockNumber };
const OPTS = { stale: false, mode: 'daemon' as const };

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');
const problems: Record<string, unknown>[] = [];

// ---------------------------------------------------------------- item 4
// Nodes 9 and 86 are named by the brief (the two the 50x sweep measured);
// the rest are whatever else the fixture actually holds occupants for, so
// the sample is never silently empty.
const WANTED_NODES = [9, 86, 10, 62, 1, 2, 3, 4, 5, 6, 7, 8];

// ---- the row shapes this section reads -------------------------------------
type Liq = { eligible?: boolean; reason?: string; threshold: number; margin: number };
type Row = { liquidation?: Liq };
type NodeAnswer = {
  harvestsTotal: number;
  harvestsEligible?: number;
  harvestsServed: number;
  harvests: Row[];
  attacker?: { index: number; blocked: string | null; cooldownSec: number; cooldownUntil: number };
};

/** THE 0.5.3 PREDICATE, written the way a caller writes it — off the numbers
 * the answer SERVES. `margin` is `threshold - hp` for the same `hp` the row
 * prints, so this cannot disagree with the payload; `canMog` re-enters
 * `calcHealth` and can. */
const targetSide = (rows: Row[]): Row[] =>
  rows.filter((r) => r.liquidation !== undefined && r.liquidation.threshold > 0 && r.liquidation.margin > 0);

/** THE 0.5.2 PREDICATE, kept as a comparison term rather than deleted: with a
 * healthy attacker the two must select the SAME rows, and that coincidence is
 * the reason 0.5.2's answers are not disturbed by this release. */
const fullPairing = (rows: Row[]): Row[] => rows.filter((r) => r.liquidation?.eligible === true);

const served = async (index: number, atk: number, filtered: boolean) =>
  (await serveQuery(
    mirror,
    'node',
    [String(index), String(atk), '--with-vitals', '--full', ...(filtered ? ['--eligible-only'] : [])],
    OPTS
  )) as { data: unknown };

// an attacker that exists in the fixture — any kami; a byte-equality check
// does not care which pairing, but 0.5.3 does care that this one is HEALTHY
// (asserted below), because the coincidence claim is only about healthy
// attackers
const attacker = queryKamis(components)
  .slice(0, 200)
  .map((e) => getKamiIndex(components, e))
  .find((i) => i > 0);
if (!attacker) fail('G7.c', { reason: 'no kami in the fixture to use as an attacker' });

const nodeCases: Record<string, unknown>[] = [];
for (const index of WANTED_NODES) {
  let full: { data: unknown };
  let filtered: { data: unknown };
  try {
    full = await served(index, attacker, false);
    filtered = await served(index, attacker, true);
  } catch {
    continue; // the fixture does not hold this node
  }
  const f = full.data as NodeAnswer;
  const e = filtered.data as NodeAnswer;

  // 0.5.3: the whole healthy-attacker claim rests on this. If the fixture's
  // first kami is ever starving or cooling, the coincidence assertion below
  // is not merely false, it is meaningless — so say which it is.
  if (f.attacker?.blocked !== null) {
    problems.push({
      check: 'the healthy-attacker loop needs an unblocked attacker',
      node: index,
      attacker,
      blocked: f.attacker?.blocked,
    });
  }

  // THE CHECK: the client-side filter a caller writes today
  const clientSide = targetSide(f.harvests);
  if (JSON.stringify(clientSide) !== JSON.stringify(e.harvests)) {
    problems.push({
      check: 'eligible-only byte equality',
      node: index,
      clientSideRows: clientSide.length,
      servedRows: e.harvests.length,
    });
  }
  // THE 0.5.2 BASELINE, RE-RUN: with a healthy attacker the target-side
  // predicate and the full pairing select the same rows, byte for byte. This
  // is what makes 0.5.3 a no-op for every caller whose kami was ready — and
  // it is the assertion that would catch the new predicate quietly widening
  // or narrowing the set beyond the attacker's own gate.
  const legacy = fullPairing(f.harvests);
  if (JSON.stringify(legacy) !== JSON.stringify(clientSide)) {
    problems.push({
      check: 'healthy attacker: 0.5.2 and 0.5.3 predicates must coincide',
      node: index,
      fullPairingRows: legacy.length,
      targetSideRows: clientSide.length,
    });
  }
  if (e.harvestsTotal !== f.harvestsTotal) {
    problems.push({
      check: 'harvestsTotal must still report the whole node',
      node: index,
      filtered: e.harvestsTotal,
      unfiltered: f.harvestsTotal,
    });
  }
  if (e.harvestsEligible !== clientSide.length) {
    problems.push({
      check: 'harvestsEligible must equal the filtered count',
      node: index,
      served: e.harvestsEligible,
      expected: clientSide.length,
    });
  }
  if (f.harvestsEligible !== undefined) {
    problems.push({ check: 'harvestsEligible must be absent without the flag', node: index });
  }
  // `attacker.blocked` is present on BOTH, flag or no flag (§3.13): the
  // question "can I act at all?" must not require asking for a filtered list
  if (!(f.attacker && 'blocked' in f.attacker) || !(e.attacker && 'blocked' in e.attacker)) {
    problems.push({ check: 'attacker.blocked must be present with or without --eligible-only', node: index });
  }
  nodeCases.push({
    node: index,
    harvestsTotal: f.harvestsTotal,
    harvestsEligible: e.harvestsEligible,
    attackerBlocked: f.attacker?.blocked ?? null,
    fullPairingRows: legacy.length,
    targetSideRows: clientSide.length,
    predicatesCoincide: JSON.stringify(legacy) === JSON.stringify(clientSide),
    bytesFull: bytes(full.data),
    bytesEligibleOnly: bytes(filtered.data),
    reductionPct:
      bytes(full.data) > 0
        ? Number((100 * (1 - bytes(filtered.data) / bytes(full.data))).toFixed(2))
        : null,
    byteEqualToClientSideFilter: JSON.stringify(clientSide) === JSON.stringify(e.harvests),
  });
}
if (nodeCases.length < 3) {
  fail('G7.c', { reason: 'fewer than 3 nodes served by the fixture', served: nodeCases.length });
}

// ------------------------------------------------ 0.5.3: the blocked attacker
//
// THE DEFECT THIS SECTION EXISTS FOR. Until 0.5.3 `--eligible-only` filtered
// on `liquidation.eligible` = `canLiquidate`, which folds in
// `isStarving(attacker)` and `onCooldown(attacker)`. In a zero-cooldown kill
// loop the attacker sits at HP 0 for 4-6 s after every kill, so a read inside
// that window answered `harvestsEligible: 0` on a node with 20+ targets under
// threshold — a payload indistinguishable from "everyone withdrew" (observed
// live on node 35, block 32677631, 2026-08-28). An empty list was reporting a
// fact about the CALLER.
//
// The claim now is: the list is the TARGET set, and the attacker's own gate is
// reported once on `attacker.blocked`. Both halves are asserted here, and the
// row the old predicate would have served is RECORDED beside them so the size
// of the defect is on the record rather than in a brief.

/** Deterministic search: the first (attacker, node) pairing in the fixture
 * where the attacker's own gate is CLOSED and at least one target is in reach.
 * Not hard-coded to a kami index — a re-cut fixture should re-find one rather
 * than fail on a stale constant — but deterministic given a fixture, because
 * the scan order is the mirror's own. */
async function findBlockedAttacker(
  want: 'ATTACKER_STARVING' | 'ATTACKER_COOLDOWN',
  nodes: number[],
  limit = 400
): Promise<{ attacker: number; blocked: string; targets: number; foundOnNode: number } | null> {
  const candidates = queryKamis(components)
    .slice(0, limit)
    .map((e) => getKamiIndex(components, e))
    .filter((i) => i > 0);
  // Search every node the assertions will run over, not one hardcoded node
  // (0.6.1). The case this builds is "a blocked attacker that HAS targets in
  // reach", and which node those targets sit on is incidental to the 0.5.3
  // claim — but it is entirely a property of the fixture. The pre-0.6.1
  // fixture happened to satisfy it on node 62; the recaptured one has 57
  // starving attackers on node 62 and no targets in reach on any of them, so
  // a search pinned to that node refused a case the fixture could in fact
  // build elsewhere. Refusing when the case is genuinely absent is right;
  // refusing because we only looked in one place is not.
  for (const atk of candidates) {
    for (const node of nodes) {
      let answer: NodeAnswer;
      try {
        answer = (await served(node, atk, false)).data as NodeAnswer;
      } catch {
        continue;
      }
      if (answer.attacker?.blocked !== want) continue;
      const targets = targetSide(answer.harvests).length;
      if (targets > 0) return { attacker: atk, blocked: want, targets, foundOnNode: node };
    }
  }
  return null;
}

/** The assertion set for a blocked attacker, run over every node the fixture
 * serves. Returns the per-node record. */
async function assertBlocked(
  atk: number,
  want: 'ATTACKER_STARVING' | 'ATTACKER_COOLDOWN',
  label: string
): Promise<Record<string, unknown>[]> {
  const cases: Record<string, unknown>[] = [];
  for (const index of WANTED_NODES) {
    let full: { data: unknown };
    let filtered: { data: unknown };
    try {
      full = await served(index, atk, false);
      filtered = await served(index, atk, true);
    } catch {
      continue;
    }
    const f = full.data as NodeAnswer;
    const e = filtered.data as NodeAnswer;
    const inReach = targetSide(f.harvests);
    const legacy = fullPairing(f.harvests);

    // 1. the attacker's gate is reported once, on the attacker
    if (f.attacker?.blocked !== want || e.attacker?.blocked !== want) {
      problems.push({
        check: `${label}: attacker.blocked must name the gate on both answers`,
        node: index,
        unfiltered: f.attacker?.blocked,
        filtered: e.attacker?.blocked,
        want,
      });
    }
    // 2. the served list is the TARGET set, byte for byte
    if (JSON.stringify(inReach) !== JSON.stringify(e.harvests)) {
      problems.push({
        check: `${label}: served rows must be the target-side set`,
        node: index,
        clientSideRows: inReach.length,
        servedRows: e.harvests.length,
      });
    }
    if (e.harvestsEligible !== inReach.length) {
      problems.push({
        check: `${label}: harvestsEligible must equal the target-side count`,
        node: index,
        served: e.harvestsEligible,
        expected: inReach.length,
      });
    }
    if (e.harvestsTotal !== f.harvestsTotal) {
      problems.push({ check: `${label}: harvestsTotal must still report the whole node`, node: index });
    }
    // 3. THE DEFECT, stated as an assertion rather than a story: where the
    //    node holds targets, 0.5.2 served NOTHING and 0.5.3 serves them
    if (inReach.length > 0) {
      if (e.harvests.length === 0) {
        problems.push({ check: `${label}: filtered list must be non-empty with targets in reach`, node: index });
      }
      if (legacy.length !== 0) {
        problems.push({
          check: `${label}: a blocked attacker can have no full-pairing-eligible row`,
          node: index,
          fullPairingRows: legacy.length,
        });
      }
      // 4. every served row still tells the caller WHY it cannot act, and the
      //    row-level reason agrees with the attacker-level one
      for (const r of e.harvests) {
        if (r.liquidation?.eligible !== false || r.liquidation?.reason !== want) {
          problems.push({
            check: `${label}: served row must keep the full-pairing verdict`,
            node: index,
            eligible: r.liquidation?.eligible,
            reason: r.liquidation?.reason,
            want,
          });
          break;
        }
      }
    }
    cases.push({
      node: index,
      attacker: atk,
      attackerBlocked: f.attacker?.blocked ?? null,
      harvestsTotal: f.harvestsTotal,
      targetsInReach: inReach.length,
      servedRows: e.harvests.length,
      harvestsEligible: e.harvestsEligible,
      rowsThe052PredicateWouldHaveServed: legacy.length,
      bytesFull: bytes(full.data),
      bytesEligibleOnly: bytes(filtered.data),
      reductionPct:
        bytes(full.data) > 0
          ? Number((100 * (1 - bytes(filtered.data) / bytes(full.data))).toFixed(2))
          : null,
    });
  }
  return cases;
}

const starvingPick = await findBlockedAttacker('ATTACKER_STARVING', WANTED_NODES);
if (!starvingPick) {
  fail('G7.c', {
    reason: 'no starving attacker with a target in reach in the fixture — the 0.5.3 case cannot be built',
  });
}
const starvingCases = await assertBlocked(starvingPick.attacker, 'ATTACKER_STARVING', 'starving attacker');
if (starvingCases.every((c) => Number(c.targetsInReach) === 0)) {
  fail('G7.c', { reason: 'the starving-attacker case reached no node with a target in reach' });
}

// ---------------------------------------------------------------- item 5
// Accounts across the size spread the fixture holds, largest first, so the
// biggest roster in the fixture is always in the sample.
const accountSizes: { index: number; kamis: number }[] = [];
for (let i = 1; i <= 400; i++) {
  try {
    const a = (await serveQuery(mirror, 'account', [String(i)], OPTS)).data as {
      kamis: unknown[];
    };
    accountSizes.push({ index: i, kamis: a.kamis.length });
  } catch {
    /* not in the fixture */
  }
}
accountSizes.sort((a, b) => b.kamis - a.kamis);
const sample = [
  ...accountSizes.slice(0, 3),
  ...accountSizes.slice(Math.floor(accountSizes.length / 2), Math.floor(accountSizes.length / 2) + 2),
  ...accountSizes.slice(-2),
].filter((v, i, arr) => arr.findIndex((x) => x.index === v.index) === i);
if (sample.length < 5) {
  fail('G7.c', { reason: 'fewer than 5 accounts in the fixture', found: accountSizes.length });
}

/** what slim promises to serve, and nothing else */
const SLIM_KEYS = [
  'id',
  'index',
  'name',
  'ownerAddress',
  'operatorAddress',
  'roomIndex',
  'stamina',
  'kamisTotal',
  'kamisServed',
  'kamis',
];
const MUST_BE_ABSENT = ['musu', 'reputation', 'bio', 'gas'];

const accountCases: Record<string, unknown>[] = [];
for (const { index } of sample) {
  const fullEnv = await serveQuery(mirror, 'account', [String(index)], OPTS);
  const slimEnv = await serveQuery(mirror, 'account', [String(index), '--slim'], OPTS);
  const f = fullEnv.data as Record<string, unknown> & { kamis: unknown[] };
  const s = slimEnv.data as Record<string, unknown> & { kamis: unknown[] };

  for (const k of Object.keys(s)) {
    if (!SLIM_KEYS.includes(k)) {
      problems.push({ check: 'slim served an undeclared field', account: index, field: k });
    }
  }
  // every slim field equals the full answer's same field (the two cap
  // fields and the emptied roster are slim's own, and checked separately)
  for (const k of Object.keys(s)) {
    if (k === 'kamisTotal' || k === 'kamisServed' || k === 'kamis') continue;
    if (JSON.stringify(s[k]) !== JSON.stringify(f[k])) {
      problems.push({ check: 'slim field differs from full', account: index, field: k });
    }
  }
  if (s.kamisTotal !== f.kamis.length) {
    problems.push({
      check: 'kamisTotal must equal the full roster length',
      account: index,
      slim: s.kamisTotal,
      full: f.kamis.length,
    });
  }
  if (s.kamisServed !== 0 || s.kamis.length !== 0) {
    problems.push({ check: 'slim must serve no roster rows', account: index });
  }
  for (const k of MUST_BE_ABSENT) {
    if (k in s) problems.push({ check: 'slim must omit this field', account: index, field: k });
  }
  // and the flag-off answer must not have grown the cap fields
  if ('kamisTotal' in f || 'kamisServed' in f) {
    problems.push({ check: 'cap fields must be absent without --slim', account: index });
  }
  accountCases.push({
    account: index,
    kamis: f.kamis.length,
    bytesFull: bytes(fullEnv.data),
    bytesSlim: bytes(slimEnv.data),
    reductionPct: Number((100 * (1 - bytes(slimEnv.data) / bytes(fullEnv.data))).toFixed(2)),
  });
}

// --------------------------- 0.5.3: the cooling attacker, NOT BUILT (recorded)
//
// A pinned ATTACKER_COOLDOWN case was designed, built and DROPPED, and the
// reason is worth more than the case would have been.
//
// Cooldown is a clock fact, so the case needs a pinned clock: the fixture's
// cooling kamis drift out of cooldown as wall time passes, and an unpinned
// case would pass today and quietly stop testing anything. Pinning to an
// instant inside the fixture's era (1755000000, G3.g's pin) does find cooling
// attackers with targets in reach — kami 83 on node 62, 28 targets, measured
// 2026-08-28 in a process that pinned BEFORE its first query.
//
// It does not survive being pinned HERE. Measured, same pin, same fixture,
// same node: pinning after this gate's earlier queries have run leaves every
// occupant projecting to full health, so `targetSide` reads 0 where a
// pin-first process reads 28 — and clearing KamiCache, HarvestCache,
// HarvestLastTs, RateCache, KamiUpdateTs and NodeUpdateTs after the pin does
// NOT restore it. Something in the projection path is stateful across the
// process beyond those caches. So the pinned result depends on what ran
// before it, which is the definition of the gate we refuse to ship: it would
// have asserted 0 == 0 and called it a pass.
//
// The STARVING case above needs none of this — it runs on the unpinned clock
// like every other check here, and the fixture's starving attackers read
// starving under both the wall clock and the pin (measured). Starving and
// cooling reach `attacker.blocked` through the SAME function
// (`attackerBlocker`) and the same precedence, so the covered case exercises
// the mechanism; what is uncovered is one enum value, not a code path.
//
// To build it properly: a separate hermetic script that pins before its first
// query, as G3.g does. That is a gate part of its own and wants its own
// review, not a bolt-on here. Recorded in SPEC as a coverage gap for 0.5.3.

const record = await writeMeasurement('g7c-payload-flags', {
  snapshotBlock: cache.blockNumber,
  attackerKamiIndex: attacker,
  eligibleOnly: {
    // READ THE REDUCTION WITH THIS IN HAND. The fixture attacker is whatever
    // kami the snapshot offers first, and a low-index kami is eligible
    // against nearly every occupant — so the fixture's saving is SMALL and
    // says nothing about the flag's value. The saving is a function of how
    // many rows are eligible, not of the flag: measured live 2026-08-27 with
    // a real attacker (kami 15671), node 9 went 500,709 B -> 3,489 B (6
    // eligible of 835), node 86 1,300,288 B -> 15,900 B (28 of 2,165) and
    // node 10 46,696 B -> 1,731 B (3 of 77). What THIS gate proves is that
    // the rows served are exactly the right ones. On an empty node the
    // filtered answer is a few bytes LARGER, because harvestsEligible is
    // real overhead on an answer with nothing in it — recorded rather than
    // hidden.
    reductionCaveat:
      'fixture attacker is eligible against most occupants, so the fixture reduction is not representative; the equality check is the assertion, the bytes are a record',
    nodesChecked: nodeCases.length,
    allByteEqualToClientSideFilter: nodeCases.every((c) => c.byteEqualToClientSideFilter === true),
    healthyAttackerPredicatesCoincide: nodeCases.every((c) => c.predicatesCoincide === true),
    cases: nodeCases,
  },
  // 0.5.3 (§3.13): the attacker-blind filter and `attacker.blocked`.
  // `rowsThe052PredicateWouldHaveServed` is the size of the defect: 0 on
  // every node where `targetsInReach` is not.
  blockedAttacker: {
    starving: {
      attacker: starvingPick.attacker,
      targetsOnSearchNode: starvingPick.targets,
      searchNode: starvingPick.foundOnNode,
      nodesChecked: starvingCases.length,
      cases: starvingCases,
    },
    cooling: {
      built: false,
      reason:
        'a pinned ATTACKER_COOLDOWN case reads targetSide 0 when the clock is pinned after this gate\'s earlier queries (28 in a pin-first process, same pin and fixture); the projection path is stateful across the process beyond KamiCache/HarvestCache/HarvestLastTs/RateCache, so the case would have asserted 0 == 0. Wants its own pin-first script — see the note in this file.',
      measuredPinFirst: { pin: 1755000000, node: 62, attacker: 83, targetsInReach: 28 },
    },
  },
  slim: {
    accountsChecked: accountCases.length,
    largestRosterInSample: Math.max(...accountCases.map((c) => Number(c.kamis))),
    cases: accountCases,
  },
  problems,
});

if (problems.length > 0) fail('G7.c', { problems: problems.slice(0, 20), record });
pass('G7.c', {
  nodes: nodeCases.length,
  accounts: accountCases.length,
  largestRoster: Math.max(...accountCases.map((c) => Number(c.kamis))),
  starvingAttacker: starvingPick.attacker,
  coolingCaseBuilt: false,
  blockedNodesChecked: starvingCases.length,
  record,
});
