// Gate G6.a [hermetic] — 0.2.0 surface cross-query consistency. The new
// outputs must agree with the already-gated surfaces they share a data
// path with, over one snapshot mirror:
//   · node --with-vitals per-occupant vitals == the kami query's answer
//     for the same kami (the G2.b/G3.c-verified path), toleranced only
//     for sub-second clock drift between the two calls;
//   · liquidation preview coherence: a liquidation block on every
//     non-attacker row, none on the attacker's own; eligible ⇒ HP below
//     threshold; threshold ≤ 0 ⇒ never eligible; spoils/salvage/recoil
//     non-negative and spoils bounded by the pot;
//   · account.stamina == an independent calcCurrentStamina recompute
//     (±1 for a recovery-tick boundary), 0 ≤ current ≤ total;
//   · inventory rows: cleanInventories contract (no zero balances,
//     ascending item index) and the MUSU row == the account query's musu;
//   · merchant listings: price-side presence rules (buyPrice ⇔ buy,
//     sellPrice ⇔ sell);
//   · phase: the served fields reproduce through the ported getPhaseOf/
//     getPhaseName at the served timestamp, and the boundary arithmetic
//     proves out (at+secondsToNext flips the phase; one second earlier
//     does not);
//   · leaderboard: 1-based contiguous ranks, values non-increasing.

import path from 'node:path';

import { resolveConfig } from '../../src/config';
import { serveQuery } from '../../src/queries';
import { calcCurrentStamina } from '../../src/app/cache/account';
import { getAccountByIndex } from '../../src/network/shapes/Account';
import { getAllNodes } from '../../src/network/shapes/Node';
import { query as queryKamis } from '../../src/network/shapes/Kami/queries';
import { getKamiIndex } from '../../src/network/shapes/utils/component';
import { getPhaseName, getPhaseOf } from '../../src/utils/time';
import {
  ARTIFACTS_DIR,
  fail,
  loadCacheFromSnapshotFile,
  pass,
  writeMeasurement,
} from '../g1/lib.mts';
import { buildMirror } from '../g2/lib.mts';

const config = resolveConfig();
const cache = await loadCacheFromSnapshotFile(path.join(ARTIFACTS_DIR, 'c2.v8snap'), config);
const { world, components } = buildMirror(cache);
const mirror = { world, components, blockNumber: cache.blockNumber };

const problems: Record<string, unknown>[] = [];
const counts: Record<string, number> = {};
const note = (area: string, n = 1) => (counts[area] = (counts[area] ?? 0) + n);

async function serve(query: string, args: string[]): Promise<unknown> {
  return (await serveQuery(mirror, query, args, { stale: false, mode: 'daemon' })).data;
}

// --- sample entities ---------------------------------------------------------
const kamiIndexes = queryKamis(components)
  .slice(0, 120)
  .map((e) => getKamiIndex(components, e))
  .filter((i) => i > 0);
const accountIndexes = new Set<number>();
for (const idx of kamiIndexes) {
  if (accountIndexes.size >= 10) break;
  const data = (await serve('kami', [String(idx)])) as { account?: { index: number } };
  if (data.account?.index) accountIndexes.add(data.account.index);
}
if (accountIndexes.size === 0) fail('G6.a', { reason: 'no sampled accounts' });

// --- node vitals vs kami query ----------------------------------------------
type Vitals = {
  hp: { current: number; total: number; percent: number };
  hpRatePerHr?: string;
  musuAccrued: number;
  cooldownSec: number;
  // §3.13 (0.5.0)
  level?: number;
  xp?: number;
  xpRequired?: number;
  levelUpReady?: boolean;
  levelUpBlockedBy?: string;
  skillPoints?: number;
};
type NodeAnswer = {
  attacker?: { index: number };
  harvestsTotal: number;
  harvestsServed: number;
  harvests: { kami: { id?: string; index: number }; vitals?: Vitals; liquidation?: {
    eligible: boolean; reason?: string; threshold: number; spoils: number; salvage: number; recoil: number;
  } }[];
};
const nodes = getAllNodes(world, components).filter((n) => n.index);
let chosen: { index: number; count: number } | null = null;
for (const n of nodes) {
  const data = (await serve('node', [String(n.index)])) as { harvestsTotal: number };
  const count = data.harvestsTotal;
  if (count > 1 && (!chosen || Math.abs(count - 30) < Math.abs(chosen.count - 30))) {
    chosen = { index: n.index, count };
  }
}
if (!chosen) fail('G6.a', { reason: 'no node with >1 active harvests' });
const nodeIndex = chosen!.index;
const withVitals = (await serve('node', [String(nodeIndex), '--with-vitals'])) as NodeAnswer;
const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
for (const h of withVitals.harvests) {
  if (!h.kami.index || !h.vitals) continue;
  const kami = (await serve('kami', [String(h.kami.index)])) as {
    hp: { current: number; total: number };
    hpRatePerHr: string;
    musu?: { accrued: number };
    cooldownSec: number;
    level?: number;
    xp?: number;
    xpRequired?: number;
    levelUpReady?: boolean;
    levelUpBlockedBy?: string;
    skillPoints?: number;
  };
  note('vitalsCompared');
  const ok =
    close(kami.hp.current, h.vitals.hp.current, 2) &&
    kami.hp.total === h.vitals.hp.total &&
    close(kami.musu?.accrued ?? 0, h.vitals.musuAccrued, 5) &&
    close(kami.cooldownSec, h.vitals.cooldownSec, 2);
  if (!ok) problems.push({ area: 'vitals', kami: h.kami.index, node: nodeIndex, vitals: h.vitals, kamiQuery: kami });
  // 0.5.0 (§3.13): the leveling block rides on the same projection, so the
  // node's occupant rows and the kami query must agree about it EXACTLY.
  // These are discrete reads — level, banked experience, the requirement
  // curve, unspent points — with nothing continuous to tolerance away, so
  // any disagreement is a real one.
  note('levelingCompared');
  const levelingOk =
    kami.level === h.vitals.level &&
    kami.xp === h.vitals.xp &&
    kami.xpRequired === h.vitals.xpRequired &&
    kami.levelUpReady === h.vitals.levelUpReady &&
    kami.levelUpBlockedBy === h.vitals.levelUpBlockedBy &&
    kami.skillPoints === h.vitals.skillPoints;
  if (!levelingOk) {
    problems.push({ area: 'leveling', reason: 'node occupant leveling differs from the kami query', kami: h.kami.index, node: nodeIndex, vitals: h.vitals, kamiQuery: kami });
  }
  // and the block must be internally coherent wherever it appears
  if (kami.xp !== undefined && kami.xpRequired !== undefined) {
    const enough = kami.xp >= kami.xpRequired;
    if (kami.levelUpReady && !enough) {
      problems.push({ area: 'leveling', reason: 'levelUpReady with too little experience', kami: h.kami.index, served: kami });
    }
    if (kami.levelUpReady === (kami.levelUpBlockedBy !== undefined)) {
      problems.push({ area: 'leveling', reason: 'levelUpBlockedBy is present exactly when it must not be, or absent when it must be', kami: h.kami.index, served: kami });
    }
    if (kami.levelUpBlockedBy === 'EXPERIENCE' && enough) {
      problems.push({ area: 'leveling', reason: 'blocked on EXPERIENCE while holding enough of it', kami: h.kami.index, served: kami });
    }
    if (!(kami.xpRequired > 0)) {
      problems.push({ area: 'leveling', reason: 'a non-positive next-level requirement', kami: h.kami.index, served: kami });
    }
  }
}

// --- 0.5.0: party and roster agree with the kami query about leveling ------
for (const a of [...accountIndexes].slice(0, 6)) {
  const party = (await serve('party', [String(a), '--full'])) as {
    kamis: { index: number; levelUpReady?: boolean; skillPoints?: number; xp?: number }[];
  };
  const roster = (await serve('roster', [String(a)])) as {
    account: { levelUpReady: number[]; skillPoints: number[][] };
  };
  const ready = new Set(roster.account.levelUpReady);
  const sp = new Map(roster.account.skillPoints.map((p) => [p[0], p[1]]));
  for (const k of party.kamis) {
    note('rosterVsPartyLeveling');
    if (ready.has(k.index) !== (k.levelUpReady === true)) {
      problems.push({ area: 'leveling', reason: 'roster levelUpReady set disagrees with the party report', account: a, kami: k.index });
    }
    if ((sp.get(k.index) ?? 0) !== (k.skillPoints ?? 0)) {
      problems.push({ area: 'leveling', reason: 'roster skillPoints set disagrees with the party report', account: a, kami: k.index });
    }
  }
  // the skills query's unspent count is the same number the vitals carry
  const someKami = party.kamis[0];
  if (someKami) {
    const skills = (await serve('skills', [String(someKami.index)])) as {
      unspent: number;
      invested: { index: number; points: number; max: number }[];
    };
    note('skillsCompared');
    if (skills.unspent !== (someKami.skillPoints ?? 0)) {
      problems.push({ area: 'skills', reason: 'the skills query and the party report disagree on unspent points', account: a, kami: someKami.index });
    }
    for (const row of skills.invested) {
      if (!(row.points > 0)) {
        problems.push({ area: 'skills', reason: 'an invested row with no points', kami: someKami.index, row });
      }
      if (row.max > 0 && row.points > row.max) {
        problems.push({ area: 'skills', reason: 'more points spent than the skill allows', kami: someKami.index, row });
      }
    }
  }
}

// --- liquidation coherence ---------------------------------------------------
const attackerIndex = withVitals.harvests.map((h) => h.kami.index).find((i) => i > 0);
if (attackerIndex !== undefined) {
  const paired = (await serve('node', [String(nodeIndex), String(attackerIndex), '--with-vitals'])) as NodeAnswer;
  if (paired.attacker?.index !== attackerIndex) {
    problems.push({ area: 'liquidation', reason: 'attacker echo missing/wrong', got: paired.attacker });
  }
  for (const h of paired.harvests) {
    if (!h.kami.index || !h.vitals) continue;
    const isAttackerRow = h.kami.index === attackerIndex;
    note('liquidationRows');
    if (isAttackerRow && h.liquidation) {
      problems.push({ area: 'liquidation', reason: 'attacker row carries a liquidation block', kami: h.kami.index });
      continue;
    }
    if (isAttackerRow) continue;
    const liq = h.liquidation;
    if (!liq) {
      problems.push({ area: 'liquidation', reason: 'non-attacker row missing liquidation block', kami: h.kami.index });
      continue;
    }
    if (liq.eligible && !(h.vitals.hp.current < liq.threshold)) {
      problems.push({ area: 'liquidation', reason: 'eligible but HP not below threshold', kami: h.kami.index, liq, hp: h.vitals.hp });
    }
    if (liq.threshold <= 0 && liq.eligible) {
      problems.push({ area: 'liquidation', reason: 'eligible under non-positive threshold', kami: h.kami.index, liq });
    }
    // 0.5.0 (§3.13): the reason is present exactly when it is needed, and it
    // is the reason the SERVED facts support — an opaque flag was the defect,
    // and a reason that contradicts the numbers beside it would be worse
    if (liq.eligible !== (liq.reason === undefined)) {
      problems.push({ area: 'liquidation', reason: 'the reason field is present exactly when it must not be, or absent when it must be', kami: h.kami.index, liq });
    }
    if (liq.reason === 'THRESHOLD_ZERO' && liq.threshold > 0) {
      problems.push({ area: 'liquidation', reason: 'THRESHOLD_ZERO reported against a positive threshold', kami: h.kami.index, liq });
    }
    if (liq.reason === 'TARGET_HP_ABOVE_THRESHOLD' && h.vitals.hp.current < liq.threshold) {
      problems.push({ area: 'liquidation', reason: 'target reported out of reach while its HP is below the threshold', kami: h.kami.index, liq, hp: h.vitals.hp });
    }
    if (liq.spoils < 0 || liq.salvage < 0 || liq.recoil < 0 || liq.spoils > h.vitals.musuAccrued) {
      problems.push({ area: 'liquidation', reason: 'preview out of bounds', kami: h.kami.index, liq, pot: h.vitals.musuAccrued });
    }
  }
}

// --- account stamina ---------------------------------------------------------
for (const a of accountIndexes) {
  const served = (await serve('account', [String(a)])) as {
    musu: number;
    stamina: { current: number; total: number };
  };
  note('staminaChecked');
  const fresh = getAccountByIndex(world, components, a, { config: true });
  const recomputed = calcCurrentStamina(fresh);
  const ok =
    close(served.stamina.current, recomputed, 1) &&
    served.stamina.total === fresh.stamina.total &&
    served.stamina.current >= 0 &&
    served.stamina.current <= served.stamina.total;
  if (!ok) problems.push({ area: 'stamina', account: a, served: served.stamina, recomputed, total: fresh.stamina.total });

  // --- inventory contract + MUSU cross-check --------------------------------
  const inv = (await serve('inventory', [String(a)])) as {
    account: { index: number };
    items: { balance: number; item: { index: number } }[];
  };
  note('inventoriesChecked');
  if (inv.account.index !== a) problems.push({ area: 'inventory', reason: 'account echo mismatch', a, got: inv.account });
  let lastIndex = -1;
  for (const row of inv.items) {
    if (row.balance <= 0) problems.push({ area: 'inventory', reason: 'zero/negative balance served', a, row });
    if (row.item.index <= lastIndex) problems.push({ area: 'inventory', reason: 'not ascending by item index', a, row });
    lastIndex = row.item.index;
  }
  const musuRow = inv.items.find((r) => r.item.index === 1);
  if ((musuRow?.balance ?? 0) !== served.musu) {
    problems.push({ area: 'inventory', reason: 'MUSU row != account.musu', a, musuRow, accountMusu: served.musu });
  }
}

// --- merchant price-side presence rules -------------------------------------
const merchants = (await serve('merchant', [])) as { merchants: { index: number }[] };
for (const m of merchants.merchants) {
  const data = (await serve('merchant', [String(m.index)])) as {
    listings?: { id: string; buy?: unknown; sell?: unknown; buyPrice?: number; sellPrice?: number }[];
  };
  for (const l of data.listings ?? []) {
    note('listingsChecked');
    if ((l.buy !== undefined) !== (l.buyPrice !== undefined) || (l.sell !== undefined) !== (l.sellPrice !== undefined)) {
      problems.push({ area: 'merchant', reason: 'price/side presence mismatch', npc: m.index, listing: l.id });
    }
    if ((l.buyPrice ?? 0) < 0 || (l.sellPrice ?? 0) < 0) {
      problems.push({ area: 'merchant', reason: 'negative price', npc: m.index, listing: l.id });
    }
  }
}

// --- phase -------------------------------------------------------------------
{
  const p = (await serve('phase', [])) as {
    phase: number; name: string; cycleHour: number; secondsToNext: number; next: string; at: number;
  };
  note('phaseChecked');
  const ok =
    p.phase === getPhaseOf(p.at) &&
    p.name === getPhaseName(p.phase) &&
    p.next === getPhaseName((p.phase % 3) + 1) &&
    p.cycleHour === Math.floor(p.at / 1000 / 3600) % 36 &&
    p.secondsToNext > 0 &&
    p.secondsToNext <= 43200 &&
    getPhaseOf(p.at + p.secondsToNext * 1000) === (p.phase % 3) + 1 &&
    getPhaseOf(p.at + (p.secondsToNext - 1) * 1000) === p.phase;
  if (!ok) problems.push({ area: 'phase', served: p });
}

// --- leaderboard rank/order contract ----------------------------------------
for (const args of [[], ['LIQUIDATE', '1', '0'], ['TOTAL_SPENT']] as string[][]) {
  const lb = (await serve('leaderboard', args)) as { rows: { rank: number; value: number }[] };
  note('leaderboardsChecked');
  lb.rows.forEach((row, i) => {
    if (row.rank !== i + 1) problems.push({ area: 'leaderboard', reason: 'rank not positional', args, i, row });
    if (i > 0 && row.value > lb.rows[i - 1].value) {
      problems.push({ area: 'leaderboard', reason: 'values increase', args, i, row });
    }
  });
}

await writeMeasurement('g6a-consistency', {
  snapshotBlock: cache.blockNumber,
  nodeIndex,
  counts,
  problems: problems.slice(0, 20),
  problemCount: problems.length,
  match: problems.length === 0,
});

if (problems.length > 0) {
  fail('G6.a', { reason: '0.2.0 consistency violations', problems: problems.slice(0, 10), problemCount: problems.length });
}
pass('G6.a', counts);
process.exit(0);
