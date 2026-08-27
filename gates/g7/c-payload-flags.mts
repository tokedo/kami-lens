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

// an attacker that exists in the fixture — any kami; eligibility is a
// pairing, and which pairing does not matter to an equality check
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
    full = await serveQuery(mirror, 'node', [String(index), String(attacker), '--with-vitals', '--full'], OPTS);
    filtered = await serveQuery(
      mirror,
      'node',
      [String(index), String(attacker), '--with-vitals', '--full', '--eligible-only'],
      OPTS
    );
  } catch {
    continue; // the fixture does not hold this node
  }
  const f = full.data as {
    harvestsTotal: number;
    harvestsEligible?: number;
    harvestsServed: number;
    harvests: { liquidation?: { eligible?: boolean } }[];
  };
  const e = filtered.data as {
    harvestsTotal: number;
    harvestsEligible?: number;
    harvestsServed: number;
    harvests: unknown[];
  };
  // THE CHECK: the client-side filter a caller writes today
  const clientSide = f.harvests.filter((r) => r.liquidation?.eligible === true);
  if (JSON.stringify(clientSide) !== JSON.stringify(e.harvests)) {
    problems.push({
      check: 'eligible-only byte equality',
      node: index,
      clientSideRows: clientSide.length,
      servedRows: e.harvests.length,
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
  nodeCases.push({
    node: index,
    harvestsTotal: f.harvestsTotal,
    harvestsEligible: e.harvestsEligible,
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
    cases: nodeCases,
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
  record,
});
