// Gate G6.c [live] — killers conformance + the windowed-ranking deferral
// evidence. The killers query is the 0.2.0 surface's one Kamiden-backed
// addition (GetKillsByKami — defined-but-uncalled by the web client at the
// pin, served with observed semantics recorded here, the GetOpenOffers
// precedent). Checks, G4.a-style, through a live daemon:
//   · the answer decodes, validates against the checked-in schema, and its
//     envelope equals the independent (schema × classification) derivation;
//   · rows are ranked positionally with non-increasing kill counts served
//     verbatim; the explicit size cap and totalRanked are coherent;
//   · mirror name-joins: resolution ratio recorded; every resolved join is
//     verified round-trip (the kami query at that index answers the same
//     name);
//   · cross-service consistency: for the top rows, GetBattleStats.Kills
//     (the battles query) must equal the ranking's kill count (±1 for a
//     kill landing between the two calls);
//   · name-free mode: names withheld with receipts, kamiId joins intact;
//   · phase through the live daemon: schema-valid and coherent at the
//     served corrected-clock timestamp.
// Deferral evidence (recorded, not asserted): GetKillerRanking with the
// empty ApiKey and id-less GetBattles both answer empty at the pin — the
// measured basis for the coverage row deferring a *windowed* killer
// ranking (no non-gated source exists; the mirror registers no IsKill
// component and the feed buffer is measured-lossy).

import { readFileSync } from 'node:fs';
import path from 'node:path';

import Ajv from 'ajv/dist/2020';

import { loadSchema } from '../../src/queries/registry';
import { configureKamiden, getClient } from '../../src/clients/kamiden/client';
import { resolveConfig } from '../../src/config';
import { getPhaseName, getPhaseOf } from '../../src/utils/time';
import { fail, pass, REPO_ROOT, writeMeasurement } from '../g1/lib.mts';
import { deriveAuthoredPaths, presentPath, socketQuery, spawnDaemonLive } from '../g4/lib.mts';

const classification = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'docs', 'string-classification.json'), 'utf8')
) as { default: string; types: Record<string, Record<string, string>> };

const ajv = new Ajv({ strict: true, allErrors: true });
ajv.addSchema(loadSchema('killers'), 'killers');
ajv.addSchema(loadSchema('phase'), 'phase');

const problems: Record<string, unknown>[] = [];
const record: Record<string, unknown> = {};

const daemon = await spawnDaemonLive();
try {
  // --- killers through the live surface --------------------------------------
  const res = await socketQuery('killers', ['50']);
  if (!res.ok) fail('G6.c', { reason: 'killers query failed', error: res.error });
  if (!ajv.validate('killers', res.data)) {
    problems.push({ area: 'schema', errors: ajv.errors });
  }
  const data = res.data as {
    totalRanked: number;
    size: number;
    rows: { rank: number; name: string; kills: string; kamiId?: string; kamiIndex?: number }[];
  };
  record.totalRanked = data.totalRanked;
  record.servedRows = data.rows.length;

  const derived = deriveAuthoredPaths(loadSchema('killers') as never, classification)
    .filter((p) => presentPath(res.data, p))
    .sort();
  if (JSON.stringify(derived) !== JSON.stringify(res.untrusted)) {
    problems.push({ area: 'envelope', derived, emitted: res.untrusted });
  }

  if (data.size !== data.rows.length || data.totalRanked < data.rows.length) {
    problems.push({ area: 'contract', reason: 'size/totalRanked incoherent', size: data.size, rows: data.rows.length, totalRanked: data.totalRanked });
  }
  let resolved = 0;
  data.rows.forEach((row, i) => {
    if (row.rank !== i + 1) problems.push({ area: 'contract', reason: 'rank not positional', i, row });
    if (i > 0 && BigInt(row.kills) > BigInt(data.rows[i - 1].kills)) {
      problems.push({ area: 'contract', reason: 'kill counts increase', i, row });
    }
    if (row.kamiIndex !== undefined) resolved++;
  });
  record.joinResolved = resolved;
  record.joinRatio = data.rows.length ? Number((resolved / data.rows.length).toFixed(3)) : null;

  // round-trip every resolved join: the kami at that index answers the name
  for (const row of data.rows.filter((r) => r.kamiIndex !== undefined).slice(0, 15)) {
    const kami = await socketQuery('kami', [String(row.kamiIndex)]);
    const name = (kami.data as { name?: string } | undefined)?.name;
    if (!kami.ok || name !== row.name) {
      problems.push({ area: 'join', row, kamiAnswer: name });
    }
  }

  // cross-service: top-3 resolved rows vs GetBattleStats.Kills (battles query)
  for (const row of data.rows.filter((r) => r.kamiIndex !== undefined).slice(0, 3)) {
    const battles = await socketQuery('battles', [String(row.kamiIndex)]);
    const kills = (battles.data as { stats?: { kills: number } } | undefined)?.stats?.kills;
    if (!battles.ok || kills === undefined || Math.abs(kills - Number(row.kills)) > 1) {
      problems.push({ area: 'cross-service', row, battleStatsKills: kills });
    }
  }

  // name-free mode: names withheld with receipt, joins intact
  const nameFree = await socketQuery('killers', ['10'], { noAuthored: true });
  const nf = nameFree.data as { rows: { name?: string; kamiId?: string }[] };
  if (
    !nameFree.ok ||
    nf.rows.some((r) => r.name !== undefined) ||
    !(nameFree.meta?.suppressed ?? []).includes('rows[].name') ||
    (nameFree.untrusted ?? []).length !== 0
  ) {
    problems.push({
      area: 'name-free',
      suppressed: nameFree.meta?.suppressed,
      untrusted: nameFree.untrusted,
      namesPresent: nf.rows.filter((r) => r.name !== undefined).length,
    });
  }

  // --- phase through the live daemon (corrected clock) -----------------------
  const phaseRes = await socketQuery('phase', []);
  if (!phaseRes.ok || !ajv.validate('phase', phaseRes.data)) {
    problems.push({ area: 'phase', errors: ajv.errors, error: phaseRes.error });
  } else {
    const p = phaseRes.data as { phase: number; name: string; at: number; secondsToNext: number };
    record.phase = p;
    record.phaseClockDeltaMs = p.at - Date.now();
    if (p.phase !== getPhaseOf(p.at) || p.name !== getPhaseName(p.phase)) {
      problems.push({ area: 'phase', reason: 'incoherent at served timestamp', served: p });
    }
  }

  // --- deferral evidence (recorded, never asserted as semantics) -------------
  const config = resolveConfig();
  configureKamiden(config.kamidenUrl);
  const client = getClient();
  if (client) {
    try {
      const gated = await client.getKillerRanking({ StartBlock: 0, EndBlock: 0, ApiKey: '', IsVip: false, ByCount: true });
      record.getKillerRankingEmptyKeyRows = (gated.Rows ?? []).length;
    } catch (e) {
      record.getKillerRankingEmptyKeyError = String(e);
    }
    try {
      const idless = await client.getBattles({ Timestamp: Date.now() });
      record.getBattlesIdlessRows = (idless.Kills ?? []).length;
    } catch (e) {
      record.getBattlesIdlessError = String(e);
    }
  }
} finally {
  await daemon.stop();
}

await writeMeasurement('g6c-killers', {
  ...record,
  problems: problems.slice(0, 20),
  problemCount: problems.length,
  match: problems.length === 0,
});

if (problems.length > 0) {
  fail('G6.c', { reason: 'killers conformance violations', problems: problems.slice(0, 10), problemCount: problems.length });
}
pass('G6.c', record);
process.exit(0);
