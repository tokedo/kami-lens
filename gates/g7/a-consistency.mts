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
//   · roster vs party: every roster row agrees with the full party report
//     for the same kami — state and health maximum exactly, projected
//     health within the ±2 the other cross-query checks allow, since the
//     two answers are evaluated at two instants and health accrues
//     continuously — and the roster carries no authored strings (its
//     untrusted list is empty, and name-free mode neither withholds a
//     field nor raises a receipt);
//   · roster compaction (prediction 3): marginal bytes per kami, roster
//     vs party, measured at the fixture's largest roster and asserted
//     against the frozen threshold below — and, since 0.4.0, measured a
//     SECOND time with the §3.12 enrichment flag on, because the roster is
//     the one place enrichment touches an answer whose compactness and
//     name-freeness are contract: the room ref it adds is fixed overhead
//     (no per-kami cost) and a room NAME is registry content, so both the
//     threshold and the empty-untrusted/name-free-identical properties must
//     survive the flag;
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
import { getRoomByIndex } from '../../src/network/shapes/Room';
import { quests as explorerQuests } from '../../src/network/explorer/quests';
import {
  getQuestObjectives,
  meetsRequirements,
  parseQuestObjectives,
  parseQuestRequirements,
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
const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

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
  // 0.5.0 (§3.13): the uncompacted shape moved behind `--full`. The
  // recompute below is unchanged in kind — it walks the same registry rows
  // and the same account blocks — and the COMPACT views get their own
  // guard immediately after this loop.
  const answer = (await serve('quests', [String(accountIndex), '--full'])) as {
    registry: QuestRow[];
  };
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

  // --- 0.5.0: PER-REQUIREMENT STATUS, recomputed ---------------------------
  // parseQuestRequirements is run again here on quest objects taken straight
  // from the projection layer, and every served requirement row must
  // reproduce it exactly — the same zero-tolerance treatment the objectives
  // get. `unmetRequirements` must additionally be the failing SUBSET, and
  // must appear on every row that reports requirementsMet: false and on no
  // other: a refusal that does not name its cause is the defect this version
  // exists to remove (§3.11).
  {
    const compactEnv = (await serve('quests', [String(accountIndex)])) as {
      view: string;
      questsTotal: number;
      quests: {
        index: number;
        requirementsMet?: boolean;
        objectives?: unknown;
        unmetRequirements?: { type: string; met: boolean; text: string; current?: number; required?: number }[];
      }[];
    };
    note('compactQuestAnswers');
    if (compactEnv.view !== 'status') {
      problems.push({ area: 'quests/compact', reason: 'default account view is not the status view', accountIndex, served: compactEnv.view });
    }
    const fullByIndex = new Map(answer.registry.map((r) => [r.index, r]));
    if (compactEnv.questsTotal !== answer.registry.length) {
      problems.push({ area: 'quests/compact', reason: 'questsTotal disagrees with the registry length', accountIndex });
    }
    for (const row of compactEnv.quests) {
      note('compactQuestRows');
      // THE PRE-ACCEPTANCE GUARD, on the compact surface: the status view
      // carries no objectives at all, so no unaccepted row can carry progress
      if (row.objectives !== undefined) {
        problems.push({ area: 'quests/compact', reason: 'the status view carried objectives', accountIndex, quest: row.index });
      }
      const full = fullByIndex.get(row.index);
      if (!full) {
        problems.push({ area: 'quests/compact', reason: 'compact row absent from the --full answer', accountIndex, quest: row.index });
        continue;
      }
      if (row.requirementsMet !== full.account?.requirementsMet) {
        problems.push({ area: 'quests/compact', reason: 'requirementsMet differs between the compact and --full answers', accountIndex, quest: row.index });
      }
      // independent recompute of the requirement side
      const quest = explorer.all().find((q) => q.index === row.index);
      if (quest) {
        parseQuestRequirements(world, components, account, quest);
        const expectMet = meetsRequirements(quest);
        if (row.requirementsMet !== expectMet) {
          problems.push({ area: 'requirement', reason: 'requirementsMet differs from recompute', accountIndex, quest: row.index, served: row.requirementsMet, expect: expectMet });
        }
        const expectUnmet = (quest.requirements ?? []).filter((c) => !(c.status?.completable ?? false));
        const served = row.unmetRequirements ?? [];
        if (expectMet) {
          if (row.unmetRequirements !== undefined) {
            problems.push({ area: 'requirement', reason: 'unmetRequirements present on a row whose requirements are met', accountIndex, quest: row.index });
          }
        } else {
          if (served.length !== expectUnmet.length) {
            problems.push({ area: 'requirement', reason: 'unmetRequirements is not the failing subset', accountIndex, quest: row.index, served: served.length, expect: expectUnmet.length });
          }
          expectUnmet.forEach((con, i) => {
            note('requirementsChecked');
            const row2 = served[i];
            if (!row2) return;
            if (row2.met !== false) {
              problems.push({ area: 'requirement', reason: 'a met requirement was listed as unmet', accountIndex, quest: row.index });
            }
            if (row2.type !== (con.target?.type ?? '')) {
              problems.push({ area: 'requirement', reason: 'requirement target type differs from recompute', accountIndex, quest: row.index, served: row2.type });
            }
            const expectCurrent = con.status?.current === undefined ? undefined : Number(con.status.current);
            const expectRequired = con.status?.target === undefined ? undefined : Number(con.status.target);
            if (row2.current !== expectCurrent) {
              problems.push({ area: 'requirement', reason: 'requirement current differs from recompute', accountIndex, quest: row.index, served: row2.current, expect: expectCurrent });
            }
            if (row2.required !== expectRequired) {
              problems.push({ area: 'requirement', reason: 'requirement required differs from recompute', accountIndex, quest: row.index, served: row2.required, expect: expectRequired });
            }
            if (!row2.text) {
              problems.push({ area: 'requirement', reason: 'an unmet requirement was served with no interpreted text — the refusal does not name its cause', accountIndex, quest: row.index });
            }
          });
        }
      }
    }

    // --- the narrowed views agree with the full answer --------------------
    const openEnv = (await serve('quests', [String(accountIndex), '--open'])) as {
      view: string;
      quests: { index: number; objectivesMet: boolean; objectives: { met: boolean }[] }[];
      completedCount: number;
      completedIndices: number[];
    };
    const acceptedEnv = (await serve('quests', [String(accountIndex), '--accepted'])) as {
      view: string;
      quests: { index: number; complete: boolean }[];
    };
    const fullAccepted = answer.registry.filter((r) => r.account?.accepted);
    const fullOpen = fullAccepted.filter((r) => !r.account!.complete);
    const fullDone = fullAccepted.filter((r) => r.account!.complete);
    if (openEnv.quests.length !== fullOpen.length) {
      problems.push({ area: 'quests/open', reason: 'the open view and the --full answer disagree on how many quests are open', accountIndex, served: openEnv.quests.length, expect: fullOpen.length });
    }
    if (openEnv.completedCount !== fullDone.length || openEnv.completedIndices.length !== fullDone.length) {
      problems.push({ area: 'quests/open', reason: 'completed count/indices disagree with the --full answer', accountIndex });
    }
    for (const row of openEnv.quests) {
      note('openQuestRows');
      const full = fullByIndex.get(row.index);
      // THE PRE-ACCEPTANCE GUARD on the open view: an unaccepted quest can
      // never reach it, so nothing here can carry pre-acceptance progress
      if (!full?.account?.accepted) {
        problems.push({ area: 'quests/open', reason: 'the open view served a quest the account has not accepted', accountIndex, quest: row.index });
      }
      if (full?.account?.complete) {
        problems.push({ area: 'quests/open', reason: 'the open view served a finished quest', accountIndex, quest: row.index });
      }
      if (JSON.stringify(row.objectives) !== JSON.stringify(full?.account?.objectives)) {
        problems.push({ area: 'quests/open', reason: 'objectives differ between the open view and the --full answer', accountIndex, quest: row.index });
      }
    }
    if (acceptedEnv.quests.length !== fullAccepted.length) {
      problems.push({ area: 'quests/accepted', reason: 'the accepted view and the --full answer disagree on how many quests are accepted', accountIndex, served: acceptedEnv.quests.length, expect: fullAccepted.length });
    }
    for (const row of acceptedEnv.quests) {
      if (!fullByIndex.get(row.index)?.account?.accepted) {
        problems.push({ area: 'quests/accepted', reason: 'the accepted view served an unaccepted quest', accountIndex, quest: row.index });
      }
    }

    // --- keyed detail is the same facts, keyed -----------------------------
    const someQuest = compactEnv.quests[0];
    if (someQuest) {
      const keyed = (await serve('quests', [String(accountIndex), String(someQuest.index)])) as {
        view: string;
        quests: { index: number; description?: string; requirementsMet?: boolean; requirements?: unknown[] }[];
      };
      note('keyedQuestAnswers');
      const row = keyed.quests[0];
      if (keyed.view !== 'detail' || keyed.quests.length !== 1 || row?.index !== someQuest.index) {
        problems.push({ area: 'quests/detail', reason: 'keyed detail did not answer with exactly the quest asked for', accountIndex, quest: someQuest.index });
      }
      if (row && row.description === undefined) {
        problems.push({ area: 'quests/detail', reason: 'keyed detail withheld the description — it is the one form that carries it', accountIndex, quest: someQuest.index });
      }
      if (row && row.requirementsMet !== someQuest.requirementsMet) {
        problems.push({ area: 'quests/detail', reason: 'keyed detail disagrees with the compact row', accountIndex, quest: someQuest.index });
      }
      if (row && !Array.isArray(row.requirements)) {
        problems.push({ area: 'quests/detail', reason: 'keyed detail served no requirements array', accountIndex, quest: someQuest.index });
      }
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
  account: { index: number; roomIndex: number; room?: { index: number; name: string } };
  kamis: { index: number; state: string; hp: number[] }[];
};

/** §3.12 enriched serving, for the roster leg below. */
async function serveEnriched(query: string, args: string[], opts = {}) {
  return serveQuery({ mirror, enrich: true }, query, args, {
    stale: false,
    mode: 'daemon',
    ...opts,
  });
}

let largest = { accountIndex: 0, kamis: 0 };
for (const accountIndex of accountIndexes) {
  const rosterEnv = await envelope('roster', [String(accountIndex)]);
  const roster = rosterEnv.data as RosterOut;
  // 0.5.0 (§3.13): `party` is capped by default, so the row-for-row
  // agreement is asserted against the uncapped answer — the point of the
  // check is that the two projections agree, not that they are the same size
  const party = (await serve('party', [String(accountIndex), '--full'])) as PartyOut;
  note('rostersChecked');

  if (rosterEnv.untrusted.length !== 0) {
    problems.push({ area: 'roster', reason: 'roster volunteered an authored string', accountIndex, untrusted: rosterEnv.untrusted });
  }
  // Name-free mode must change NOTHING about this answer: no field
  // withheld, no receipt raised, no roster row added or dropped. Health is
  // a continuous projection and the two calls are not simultaneous, so the
  // comparison is structural — the same kamis in the same states, with the
  // same maxima — plus the receipt and untrusted-list properties. Comparing
  // projected health across two instants would be testing the clock.
  const nameFree = await envelope('roster', [String(accountIndex)], { noAuthored: true });
  const shapeOf = (r: RosterOut) =>
    JSON.stringify({
      account: r.account,
      kamis: r.kamis.map((k) => ({ index: k.index, state: k.state, total: k.hp[1] })),
    });
  if (shapeOf(nameFree.data as RosterOut) !== shapeOf(roster)) {
    problems.push({ area: 'roster', reason: 'name-free mode changed the answer', accountIndex });
  }
  if (nameFree.untrusted.length !== 0 || nameFree.meta.suppressed !== undefined) {
    problems.push({ area: 'roster', reason: 'name-free mode raised a receipt on a name-free answer', accountIndex, untrusted: nameFree.untrusted, suppressed: nameFree.meta.suppressed });
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
    // The health MAXIMUM is a stat and must match exactly. Current health
    // is a continuous projection evaluated at two different instants, so it
    // is toleranced the way the other cross-query checks tolerance it (±2)
    // — the failure this guards against is a wrong health, not a health
    // that moved by a tick between two calls.
    if (row.hp[1] !== full.hp.total || !close(row.hp[0], full.hp.current, 2)) {
      problems.push({ area: 'roster', reason: 'hp differs from the party report', accountIndex, kami: row.index, roster: row.hp, party: full.hp });
    }
  }
  if (roster.kamis.length > largest.kamis) largest = { accountIndex, kamis: roster.kamis.length };
}

// --- §3.12: the enriched roster keeps every roster guarantee ----------------
const enrichedRoster: Record<string, unknown> = { measured: false };
if (largest.kamis > 0) {
  const accountIndex = largest.accountIndex;
  const env = await serveEnriched('roster', [String(accountIndex)]);
  const roster = env.data as RosterOut;
  const nameFree = await serveEnriched('roster', [String(accountIndex)], { noAuthored: true });
  const account = getAccountByIndex(world, components, accountIndex);
  const room = roster.account.room;
  enrichedRoster.measured = true;
  enrichedRoster.accountIndex = accountIndex;
  enrichedRoster.room = room ?? null;
  enrichedRoster.untrusted = env.untrusted;

  if (env.untrusted.length !== 0) {
    problems.push({ area: 'roster/enrich', reason: 'enriched roster volunteered an authored string', untrusted: env.untrusted });
  }
  if (JSON.stringify(nameFree.data) !== JSON.stringify(roster)) {
    problems.push({ area: 'roster/enrich', reason: 'name-free mode changed the enriched answer' });
  }
  if (nameFree.meta.suppressed !== undefined || nameFree.untrusted.length !== 0) {
    problems.push({ area: 'roster/enrich', reason: 'name-free mode raised a receipt on a name-free answer' });
  }
  if (!room || room.index !== account.roomIndex) {
    problems.push({ area: 'roster/enrich', reason: 'enriched roster room does not resolve the account roomIndex', room, roomIndex: account.roomIndex });
  }
  // {index, name} only: the compact answer must not grow a description
  if (room && Object.keys(room).sort().join(',') !== 'index,name') {
    problems.push({ area: 'roster/enrich', reason: 'enriched roster room is not {index, name}', room });
  }
  if (room && room.name !== (getRoomByIndex(world, components, account.roomIndex)?.name ?? '')) {
    problems.push({ area: 'roster/enrich', reason: 'enriched roster room name disagrees with the room shape', room });
  }
}

// --- prediction 3: marginal bytes per kami ----------------------------------
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');
let compaction: Record<string, unknown> = { measured: false };
if (largest.kamis > 0) {
  const roster = (await serve('roster', [String(largest.accountIndex)])) as RosterOut;
  // uncapped, so the marginal-bytes-per-kami comparison has every row on
  // both sides (the cap is measured separately, in the capped-listing block)
  const party = (await serve('party', [String(largest.accountIndex), '--full'])) as PartyOut;
  const rosterEmpty = bytes({ ...roster, kamis: [] });
  const partyEmpty = bytes({ ...party, kamis: [] });
  const rosterMarginal = (bytes(roster) - rosterEmpty) / largest.kamis;
  const partyMarginal = (bytes(party) - partyEmpty) / largest.kamis;
  // 0.5.0 (§3.13): the two cheap leveling signals are SETS on the account
  // block, not fields on the kami rows, and that placement is the whole
  // argument. `rosterEmpty` includes them, so they cancel out of the
  // marginal above BY CONSTRUCTION — which is why the ratio is unchanged at
  // every roster composition rather than at the composition we happened to
  // measure. Assert the sets are correct, and that the marginal really did
  // not move.
  {
    const acc = roster.account as unknown as {
      levelUpReady?: number[];
      skillPoints?: number[][];
    };
    if (!Array.isArray(acc.levelUpReady) || !Array.isArray(acc.skillPoints)) {
      problems.push({ area: 'roster/leveling', reason: 'the leveling sets are not on the account block', accountIndex: largest.accountIndex });
    } else {
      const rows = new Set(roster.kamis.map((k) => k.index));
      for (const index of acc.levelUpReady) {
        if (!rows.has(index)) {
          problems.push({ area: 'roster/leveling', reason: 'levelUpReady named a kami that is not in the roster', accountIndex: largest.accountIndex, kami: index });
        }
      }
      for (const pair of acc.skillPoints) {
        if (!Array.isArray(pair) || pair.length !== 2 || !rows.has(pair[0]) || !(pair[1] > 0)) {
          problems.push({ area: 'roster/leveling', reason: 'a skillPoints entry is not [kamiIndex, positivePoints] for a roster kami', accountIndex: largest.accountIndex, pair });
        }
      }
      // every set member must agree with the party report for the same kami
      const partyByIndex = new Map(
        (party.kamis as unknown as { index: number; levelUpReady?: boolean; skillPoints?: number }[]).map(
          (k) => [k.index, k]
        )
      );
      const readySet = new Set(acc.levelUpReady);
      const spMap = new Map(acc.skillPoints.map((p) => [p[0], p[1]]));
      for (const [index, full] of partyByIndex) {
        note('rosterLevelingRowsChecked');
        if (readySet.has(index) !== (full.levelUpReady === true)) {
          problems.push({ area: 'roster/leveling', reason: 'levelUpReady disagrees with the party report', accountIndex: largest.accountIndex, kami: index });
        }
        if ((spMap.get(index) ?? 0) !== (full.skillPoints ?? 0)) {
          problems.push({ area: 'roster/leveling', reason: 'skillPoints disagrees with the party report', accountIndex: largest.accountIndex, kami: index });
        }
      }
    }
  }
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
  // the same measurement with the §3.12 flag on: the room ref is fixed
  // overhead, so the MARGINAL cost per kami must not move at all
  const enriched = (await serveEnriched('roster', [String(largest.accountIndex)])).data as RosterOut;
  const enrichedEmpty = bytes({ ...enriched, kamis: [] });
  const enrichedMarginal = (bytes(enriched) - enrichedEmpty) / largest.kamis;
  const enrichedRatio = enrichedMarginal / partyMarginal;
  compaction.enriched = {
    rosterBytes: bytes(enriched),
    fixedOverheadDeltaBytes: enrichedEmpty - rosterEmpty,
    rosterMarginalBytesPerKami: Number(enrichedMarginal.toFixed(2)),
    marginalRatio: Number(enrichedRatio.toFixed(4)),
  };
  if (!(enrichedRatio <= ROSTER_MARGINAL_BYTES_MAX_RATIO)) {
    problems.push({ area: 'roster/enrich', reason: 'compaction prediction falsified under enrich', compaction });
  }
  if (Number(enrichedMarginal.toFixed(6)) !== Number(rosterMarginal.toFixed(6))) {
    problems.push({ area: 'roster/enrich', reason: 'enrichment charged a PER-KAMI cost; it must be fixed overhead only', compaction });
  }
  if (!(ratio <= ROSTER_MARGINAL_BYTES_MAX_RATIO)) {
    problems.push({ area: 'roster', reason: 'compaction prediction falsified', compaction });
  }
  // §3.13: the leveling sets must be FIXED overhead, exactly as the enriched
  // room ref is. A per-kami cost here would mean the placement argument is
  // wrong, and the frozen threshold would then be passing on composition
  // rather than on construction.
  {
    const stripped = {
      ...roster,
      account: Object.fromEntries(
        Object.entries(roster.account as unknown as Record<string, unknown>).filter(
          ([k]) => k !== 'levelUpReady' && k !== 'skillPoints'
        )
      ),
    };
    const strippedEmpty = bytes({ ...stripped, kamis: [] });
    const strippedMarginal = (bytes(stripped) - strippedEmpty) / largest.kamis;
    compaction.leveling = {
      fixedOverheadDeltaBytes: rosterEmpty - strippedEmpty,
      marginalWithSets: Number(rosterMarginal.toFixed(6)),
      marginalWithoutSets: Number(strippedMarginal.toFixed(6)),
    };
    if (Number(strippedMarginal.toFixed(6)) !== Number(rosterMarginal.toFixed(6))) {
      problems.push({ area: 'roster/leveling', reason: 'the leveling sets charged a PER-KAMI cost; they must be fixed overhead only', compaction });
    }
  }
}

// --- 0.5.0 (§3.13): every capped listing is honest about its cap ------------
// A truncated answer that did not say so would be worse than a big one: the
// reader cannot tell "nobody else is here" from "the rest did not fit".
const CAP = 50;
const capCases: { query: string; args: string[]; total: string; served: string; rows: string }[] = [
  { query: 'room', args: ['12'], total: 'accountsTotal', served: 'accountsServed', rows: 'accounts' },
  { query: 'node', args: ['9', '--with-vitals'], total: 'harvestsTotal', served: 'harvestsServed', rows: 'harvests' },
  { query: 'party', args: [String(largest.accountIndex)], total: 'kamisTotal', served: 'kamisServed', rows: 'kamis' },
  { query: 'leaderboard', args: [], total: 'rowsTotal', served: 'rowsServed', rows: 'rows' },
  { query: 'trades', args: [], total: 'openTotal', served: 'openServed', rows: 'open' },
];
const capReport: Record<string, unknown>[] = [];
for (const c of capCases) {
  const compact = (await serve(c.query, c.args)) as Record<string, unknown>;
  const full = (await serve(c.query, [...c.args, '--full'])) as Record<string, unknown>;
  const total = compact[c.total] as number;
  const servedCount = compact[c.served] as number;
  const rows = compact[c.rows] as unknown[];
  const fullRows = full[c.rows] as unknown[];
  note('cappedListingsChecked');
  capReport.push({
    query: `${c.query} ${c.args.join(' ')}`.trim(),
    total,
    served: servedCount,
    compactBytes: bytes(compact),
    fullBytes: bytes(full),
  });
  if (typeof total !== 'number' || typeof servedCount !== 'number') {
    problems.push({ area: 'cap', reason: 'a capped listing did not serve both counts', query: c.query });
    continue;
  }
  if (servedCount !== rows.length) {
    problems.push({ area: 'cap', reason: 'servedCount disagrees with the rows actually served', query: c.query, servedCount, rows: rows.length });
  }
  if (servedCount > CAP) {
    problems.push({ area: 'cap', reason: 'the cap did not fire', query: c.query, servedCount });
  }
  if (servedCount > total) {
    problems.push({ area: 'cap', reason: 'served more rows than exist', query: c.query, servedCount, total });
  }
  if (servedCount !== Math.min(total, CAP)) {
    problems.push({ area: 'cap', reason: 'served neither the whole list nor a full cap', query: c.query, servedCount, total });
  }
  // --full lifts it, and the compact rows are the PREFIX of the full ones:
  // the order is unconditional, so the two answers must agree about which
  // rows come first
  if ((full[c.served] as number) !== total || fullRows.length !== total) {
    problems.push({ area: 'cap', reason: '--full did not lift the cap', query: c.query, total, fullServed: full[c.served] });
  }
  if (total > CAP && bytes(compact) >= bytes(full)) {
    problems.push({ area: 'cap', reason: 'the compact answer is not smaller than the full one', query: c.query });
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
  capReport,
  enrichedRoster,
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
