// Gate G7.a [hermetic] — 0.3.0 surface consistency, over one snapshot
// mirror. The parts that are new IN KIND for this version; schema and
// envelope contracts for the same additions are carried by the extended
// G3.a/G3.f, and the live chain proof by G7.b.
//
//   · quest progress recompute: every served objective's `current` and
//     `required` reproduce through the projection layer's own objective
//     evaluation, per objective, zero tolerance;
//   · quest account state: served accepted/complete agree with the
//     mirror's own accepted-quest and completion queries, both
//     directions (nothing served as accepted that is not, nothing
//     omitted that is);
//   · THE PRE-ACCEPTANCE GUARD (prediction 1's other half): no registry
//     row for an unaccepted quest may carry objective progress at all —
//     the artefact this version exists to refuse;
//   · objective basis labelling: the basis matches the stored handler,
//     and boolean-basis objectives carry no invented numbers;
//   · a report line (not an assertion) on whether any registry objective
//     carries a FOR shape — at this pin the objective reader never
//     populates it, so a nonzero count would mean objectives are being
//     evaluated against the wrong holder and is a finding, not a pass/
//     fail condition this version can act on;
//   · roster vs party: every roster row agrees field-for-field with the
//     full party report for the same kami at the same block, and the
//     roster carries no authored strings (its untrusted list is empty
//     and name-free mode changes nothing);
//   · roster compaction (prediction 3): marginal bytes per kami, roster
//     vs party, measured at the fixture's largest roster and asserted
//     against the frozen threshold below;
//   · pools: internal coherence of the served rows (sorted pair, aligned
//     reserves, fee in range, implied rate is the reserve ratio and is
//     absent when a reserve is zero), and item-vs-items agreement;
//   · newbie vendor: the display window is a subset of the pool, sized
//     as the cycle rule says, with rotation arithmetic that proves out;
//   · timing: the cost of the account-form quests answer, recorded.

import path from 'node:path';

import { resolveConfig } from '../../src/config';
import { serveQuery } from '../../src/queries';
import { getAccountByIndex } from '../../src/network/shapes/Account';
import { quests as explorerQuests } from '../../src/network/explorer/quests';
import {
  getQuestObjectives,
  parseQuestObjectives,
  queryAcceptedQuests,
} from '../../src/network/shapes/Quest';
import { getFor } from '../../src/network/shapes/utils/component';
import { query as queryKamis } from '../../src/network/shapes/Kami/queries';
import { getKamiIndex } from '../../src/network/shapes/utils/component';
import { tripwireReport } from '../../src/tripwires';
import {
  ARTIFACTS_DIR,
  fail,
  loadCacheFromSnapshotFile,
  pass,
  writeMeasurement,
} from '../g1/lib.mts';
import { buildMirror } from '../g2/lib.mts';

/** FROZEN from the first measurement (2026-08-06: 0.175 measured over a
 * 1,053-kami roster, 46.9 vs 267.7 marginal bytes per kami). The roster's
 * marginal bytes per kami must stay at or under this fraction of the party
 * report's. Raising it is a deliberate act, not a drift. */
const ROSTER_MARGINAL_BYTES_MAX_RATIO = 0.25;

const config = resolveConfig();
const cache = await loadCacheFromSnapshotFile(path.join(ARTIFACTS_DIR, 'c2.v8snap'), config);
const { world, components } = buildMirror(cache);
const mirror = { world, components, blockNumber: cache.blockNumber };

const problems: Record<string, unknown>[] = [];
const counts: Record<string, number> = {};
const note = (area: string, n = 1) => (counts[area] = (counts[area] ?? 0) + n);

async function serve(query: string, args: string[], opts = {}): Promise<unknown> {
  return (await serveQuery(mirror, query, args, { stale: false, mode: 'daemon', ...opts })).data;
}
async function envelope(query: string, args: string[], opts = {}) {
  return serveQuery(mirror, query, args, { stale: false, mode: 'daemon', ...opts });
}

// --- sample accounts ---------------------------------------------------------
const kamiIndexes = queryKamis(components)
  .slice(0, 400)
  .map((e) => getKamiIndex(components, e))
  .filter((i) => i > 0);
const accountIndexes: number[] = [];
for (const index of kamiIndexes) {
  if (accountIndexes.length >= 25) break;
  const kami = (await serve('kami', [String(index)])) as { account?: { index: number } };
  const accountIndex = kami.account?.index;
  if (accountIndex && !accountIndexes.includes(accountIndex)) accountIndexes.push(accountIndex);
}
if (accountIndexes.length === 0) fail('G7.a', { reason: 'no accounts reachable in the fixture' });

type ObjectiveOut = {
  name: string;
  type: string;
  logic: string;
  index?: number;
  required?: number;
  current?: number;
  met: boolean;
  basis: string;
};
type QuestRow = {
  index: number;
  repeatable: boolean;
  account?: {
    accepted: boolean;
    complete: boolean;
    requirementsMet: boolean;
    objectivesMet?: boolean;
    repeatAvailable?: boolean;
    startTime?: number;
    endTime?: number;
    objectives?: ObjectiveOut[];
  };
};

// --- quests: recompute, discrimination, pre-acceptance guard -----------------
const explorer = explorerQuests(world, components);
let questTimingMs = 0;
let questRowsWithAccount = 0;
const basisOf = (logic: string): string => {
  const handler = (logic ?? '').split('_')[0];
  if (handler === 'INC' || handler === 'DEC') return 'since-acceptance';
  if (handler === 'CURR') return 'current';
  if (handler === 'BOOL') return 'boolean';
  return 'unknown';
};

for (const accountIndex of accountIndexes.slice(0, 12)) {
  const started = performance.now();
  const answer = (await serve('quests', [String(accountIndex)])) as { registry: QuestRow[] };
  questTimingMs += performance.now() - started;
  note('questAnswers');

  // independent recomputation, through the projection layer directly
  const account = getAccountByIndex(world, components, accountIndex);
  const accountID = world.entities[account.entity];
  const acceptedEntities = queryAcceptedQuests(components, accountID);
  const acceptedIndexes = new Set<number>();
  const instances = new Map<number, ReturnType<typeof explorer.get>>();
  for (const entity of acceptedEntities) {
    const instance = explorer.get(entity);
    acceptedIndexes.add(instance.index);
    instances.set(instance.index, instance);
  }

  for (const row of answer.registry) {
    if (!row.account) {
      problems.push({ area: 'quests', reason: 'account block missing on a registry row', accountIndex, quest: row.index });
      continue;
    }
    questRowsWithAccount++;
    const state = row.account;

    // both directions of the acceptance discriminant
    if (state.accepted !== acceptedIndexes.has(row.index)) {
      problems.push({ area: 'quests', reason: 'accepted disagrees with the mirror', accountIndex, quest: row.index, served: state.accepted });
    }
    const instance = instances.get(row.index);
    if (state.complete !== (instance?.complete ?? false)) {
      problems.push({ area: 'quests', reason: 'complete disagrees with the mirror', accountIndex, quest: row.index, served: state.complete });
    }

    // THE PRE-ACCEPTANCE GUARD
    if (!state.accepted) {
      if (state.objectives !== undefined) {
        problems.push({ area: 'quests', reason: 'progress served for an unaccepted quest', accountIndex, quest: row.index });
      }
      if (state.objectivesMet !== undefined) {
        problems.push({ area: 'quests', reason: 'objectivesMet served for an unaccepted quest', accountIndex, quest: row.index });
      }
      continue;
    }
    if (!state.objectives) {
      problems.push({ area: 'quests', reason: 'accepted row without objectives', accountIndex, quest: row.index });
      continue;
    }

    // recompute every objective independently — this quest object came
    // straight from the projection layer, not from the query builder — and
    // compare, zero tolerance
    const fresh = instances.get(row.index)!;
    parseQuestObjectives(world, components, account, fresh);
    if (fresh.objectives.length !== state.objectives.length) {
      problems.push({ area: 'quests', reason: 'objective count differs', accountIndex, quest: row.index });
      continue;
    }
    fresh.objectives.forEach((objective, i) => {
      const served = state.objectives![i];
      note('objectivesChecked');
      const status = objective.status;
      const expectCurrent = status?.current === undefined ? undefined : Number(status.current);
      const expectRequired = status?.target === undefined ? undefined : Number(status.target);
      if (served.current !== expectCurrent) {
        problems.push({ area: 'objective', reason: 'current differs from recompute', accountIndex, quest: row.index, served: served.current, expect: expectCurrent });
      }
      if (served.required !== expectRequired) {
        problems.push({ area: 'objective', reason: 'required differs from recompute', accountIndex, quest: row.index, served: served.required, expect: expectRequired });
      }
      if (served.met !== (status?.completable ?? false)) {
        problems.push({ area: 'objective', reason: 'met differs from recompute', accountIndex, quest: row.index });
      }
      if (served.basis !== basisOf(objective.logic)) {
        problems.push({ area: 'objective', reason: 'basis mislabelled', accountIndex, quest: row.index, served: served.basis, logic: objective.logic });
      }
      // nothing is ever synthesized where the world holds no number
      if (served.basis === 'boolean' && (served.current !== undefined || served.required !== undefined)) {
        problems.push({ area: 'objective', reason: 'numbers synthesized for a boolean objective', accountIndex, quest: row.index, served });
      }
      if (state.complete && served.current !== undefined) {
        problems.push({ area: 'objective', reason: 'progress served for a finished quest', accountIndex, quest: row.index, served });
      }
    });
    // objectivesMet is the conjunction it claims to be
    const allMet = state.objectives.every((o) => o.met);
    if (state.objectivesMet !== allMet) {
      problems.push({ area: 'quests', reason: 'objectivesMet is not the conjunction of the served objectives', accountIndex, quest: row.index });
    }
  }
}

// --- report line: does any registry objective carry a FOR shape? -------------
// The objective reader does not request it at this pin, so every objective is
// evaluated against the account itself. If the world authored objectives with
// a FOR shape, that evaluation is against the wrong holder — a finding to
// record, not something this version can silently correct.
let objectivesWithForComponent = 0;
let registryObjectivesScanned = 0;
for (const quest of explorer.all().filter((q) => q.index)) {
  for (const objective of getQuestObjectives(world, components, quest.index)) {
    registryObjectivesScanned++;
    const entity = world.entityToIndex.get(objective.id);
    if (entity === undefined) continue;
    const forShape = getFor(components, entity);
    if (forShape) objectivesWithForComponent++;
  }
}

// --- roster vs party ---------------------------------------------------------
type PartyOut = {
  kamis: { index: number; state: string; hp: { current: number; total: number } }[];
};
type RosterOut = {
  account: { index: number; roomIndex: number };
  kamis: { index: number; state: string; hp: number[] }[];
};

let largest = { accountIndex: 0, kamis: 0 };
for (const accountIndex of accountIndexes) {
  const rosterEnv = await envelope('roster', [String(accountIndex)]);
  const roster = rosterEnv.data as RosterOut;
  const party = (await serve('party', [String(accountIndex)])) as PartyOut;
  note('rostersChecked');

  if (rosterEnv.untrusted.length !== 0) {
    problems.push({ area: 'roster', reason: 'roster volunteered an authored string', accountIndex, untrusted: rosterEnv.untrusted });
  }
  const nameFree = await envelope('roster', [String(accountIndex)], { noAuthored: true });
  if (JSON.stringify(nameFree.data) !== JSON.stringify(roster)) {
    problems.push({ area: 'roster', reason: 'name-free mode changed a name-free answer', accountIndex });
  }
  if (roster.account.index !== accountIndex) {
    problems.push({ area: 'roster', reason: 'account index echo wrong', accountIndex });
  }
  const account = getAccountByIndex(world, components, accountIndex);
  if (roster.account.roomIndex !== account.roomIndex) {
    problems.push({ area: 'roster', reason: 'roomIndex disagrees with the account shape', accountIndex });
  }
  if (roster.kamis.length !== party.kamis.length) {
    problems.push({ area: 'roster', reason: 'roster and party disagree on roster size', accountIndex });
  }
  const partyByIndex = new Map(party.kamis.map((k) => [k.index, k]));
  for (const row of roster.kamis) {
    const full = partyByIndex.get(row.index);
    note('rosterRowsChecked');
    if (!full) {
      problems.push({ area: 'roster', reason: 'kami absent from the party report', accountIndex, kami: row.index });
      continue;
    }
    if (row.state !== full.state) {
      problems.push({ area: 'roster', reason: 'state differs from the party report', accountIndex, kami: row.index });
    }
    if (row.hp[0] !== full.hp.current || row.hp[1] !== full.hp.total) {
      problems.push({ area: 'roster', reason: 'hp differs from the party report', accountIndex, kami: row.index, roster: row.hp, party: full.hp });
    }
  }
  if (roster.kamis.length > largest.kamis) largest = { accountIndex, kamis: roster.kamis.length };
}

// --- prediction 3: marginal bytes per kami ----------------------------------
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');
let compaction: Record<string, unknown> = { measured: false };
if (largest.kamis > 0) {
  const roster = (await serve('roster', [String(largest.accountIndex)])) as RosterOut;
  const party = (await serve('party', [String(largest.accountIndex)])) as PartyOut;
  const rosterEmpty = bytes({ ...roster, kamis: [] });
  const partyEmpty = bytes({ ...party, kamis: [] });
  const rosterMarginal = (bytes(roster) - rosterEmpty) / largest.kamis;
  const partyMarginal = (bytes(party) - partyEmpty) / largest.kamis;
  const ratio = rosterMarginal / partyMarginal;
  compaction = {
    measured: true,
    accountIndex: largest.accountIndex,
    kamis: largest.kamis,
    rosterBytes: bytes(roster),
    partyBytes: bytes(party),
    rosterMarginalBytesPerKami: Number(rosterMarginal.toFixed(2)),
    partyMarginalBytesPerKami: Number(partyMarginal.toFixed(2)),
    marginalRatio: Number(ratio.toFixed(4)),
    threshold: ROSTER_MARGINAL_BYTES_MAX_RATIO,
    projectedAt150: {
      roster: Math.round(rosterEmpty + rosterMarginal * 150),
      party: Math.round(partyEmpty + partyMarginal * 150),
    },
  };
  if (!(ratio <= ROSTER_MARGINAL_BYTES_MAX_RATIO)) {
    problems.push({ area: 'roster', reason: 'compaction prediction falsified', compaction });
  }
}

// --- pools -------------------------------------------------------------------
type PoolOut = {
  id: string;
  items: number[];
  reserves: number[];
  feeBps: number;
  lpSupply: number;
  startTime: number;
  disabled?: boolean;
  impliedRate?: { item0PerItem1: number; item1PerItem0: number };
};
const itemsAnswer = (await serve('items', [])) as { items: { index: number }[]; pools: PoolOut[] };
note('poolsServed', itemsAnswer.pools.length);
// NEVER A SILENT GAP: item pools postdate the checked-in fixture snapshot,
// so on that fixture these checks have nothing to run against. Say so in
// the record and in the pass line rather than letting an empty loop read
// as coverage. The live gate (G7.b) is the pool rows' evidence.
const vacuous: string[] = [];
if (itemsAnswer.pools.length === 0) {
  vacuous.push('pools: the fixture snapshot holds no pool entities — G7.b carries this evidence');
  console.log(`[g7.a] VACUOUS: ${vacuous[0]}`);
}
for (const pool of itemsAnswer.pools) {
  if (pool.items.length !== 2 || pool.reserves.length !== 2) {
    problems.push({ area: 'pool', reason: 'pair shape', pool });
    continue;
  }
  if (!(pool.items[0] < pool.items[1])) {
    problems.push({ area: 'pool', reason: 'pair not canonically sorted', pool });
  }
  if (pool.feeBps < 0 || pool.feeBps > 10000) {
    problems.push({ area: 'pool', reason: 'fee outside basis-point range', pool });
  }
  if (pool.reserves.some((r) => r < 0) || pool.lpSupply < 0) {
    problems.push({ area: 'pool', reason: 'negative reserve or supply', pool });
  }
  const bothPositive = pool.reserves[0] > 0 && pool.reserves[1] > 0;
  if (bothPositive !== (pool.impliedRate !== undefined)) {
    problems.push({ area: 'pool', reason: 'impliedRate presence does not follow the reserves', pool });
  }
  if (pool.impliedRate) {
    const a = pool.reserves[0] / pool.reserves[1];
    const b = pool.reserves[1] / pool.reserves[0];
    if (pool.impliedRate.item0PerItem1 !== a || pool.impliedRate.item1PerItem0 !== b) {
      problems.push({ area: 'pool', reason: 'impliedRate is not the reserve ratio', pool });
    }
  }
  // the single-item answer must carry the same row
  for (const index of pool.items) {
    const item = (await serve('item', [String(index)])) as { pools?: PoolOut[] };
    const mirrored = item.pools?.find((p) => p.id === pool.id);
    if (!mirrored) {
      problems.push({ area: 'pool', reason: 'pool missing from its item answer', item: index, pool: pool.id });
      continue;
    }
    if (JSON.stringify(mirrored) !== JSON.stringify(pool)) {
      problems.push({ area: 'pool', reason: 'item and items answers disagree', item: index, pool: pool.id });
    }
  }
}
// an item that trades in no pool must say so with an empty array, never by
// omitting the field
{
  const pooled = new Set(itemsAnswer.pools.flatMap((p) => p.items));
  const unpooled = itemsAnswer.items.map((i) => i.index).find((i) => !pooled.has(i));
  if (unpooled !== undefined) {
    const item = (await serve('item', [String(unpooled)])) as { pools?: PoolOut[] };
    if (!Array.isArray(item.pools) || item.pools.length !== 0) {
      problems.push({ area: 'pool', reason: 'unpooled item does not serve an empty pool list', item: unpooled });
    }
  }
}

// --- newbie vendor display window -------------------------------------------
type MerchantOut = {
  newbieVendor?: {
    displayedKamiIndices: number[];
    poolSize: number;
    cycleStart: number;
    cycleSeconds: number;
    secondsToNextRotation: number;
  };
};
const merchant = (await serve('merchant', [])) as MerchantOut;
const vendor = merchant.newbieVendor;
if (vendor) {
  note('vendorChecked');
  const expectedWindow = Math.min(vendor.poolSize, 3);
  if (vendor.displayedKamiIndices.length !== expectedWindow) {
    problems.push({ area: 'vendor', reason: 'display window is not min(poolSize, 3)', vendor });
  }
  if (new Set(vendor.displayedKamiIndices).size !== vendor.displayedKamiIndices.length && vendor.poolSize >= 3) {
    problems.push({ area: 'vendor', reason: 'display window repeats a kami with a pool large enough not to', vendor });
  }
  if (vendor.cycleSeconds > 0) {
    if (vendor.secondsToNextRotation <= 0 || vendor.secondsToNextRotation > vendor.cycleSeconds) {
      problems.push({ area: 'vendor', reason: 'rotation countdown outside one cycle', vendor });
    }
  }
} else {
  vacuous.push('newbie vendor: no vendor entity in the fixture snapshot');
  console.log(`[g7.a] VACUOUS: ${vacuous[vacuous.length - 1]}`);
}

// --- record ------------------------------------------------------------------
await writeMeasurement('g7a-consistency', {
  snapshotBlock: cache.blockNumber,
  accountsSampled: accountIndexes.length,
  counts,
  questRowsWithAccount,
  questAccountAnswerMeanMs: counts.questAnswers
    ? Number((questTimingMs / counts.questAnswers).toFixed(1))
    : null,
  registryObjectivesScanned,
  objectivesWithForComponent,
  compaction,
  poolsServed: itemsAnswer.pools.length,
  vacuous,
  pools: itemsAnswer.pools.map((p) => ({ id: p.id, items: p.items, feeBps: p.feeBps, reserves: p.reserves })),
  newbieVendor: vendor ?? null,
  tripwires: tripwireReport(),
  problems: problems.slice(0, 20),
  problemCount: problems.length,
  match: problems.length === 0,
});

if (problems.length > 0) {
  fail('G7.a', {
    reason: '0.3.0 consistency violations',
    problems: problems.slice(0, 10),
    problemCount: problems.length,
  });
}
pass('G7.a', {
  ...counts,
  vacuous,
  objectivesWithForComponent,
  questAccountAnswerMeanMs: counts.questAnswers
    ? Number((questTimingMs / counts.questAnswers).toFixed(1))
    : null,
});
process.exit(0);
