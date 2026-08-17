// Gate G5.c [hermetic] — config precedence matrix (DESIGN §5). One key
// (checkpoint_interval_ms) is set at all four levels with distinct
// values; every pairwise combination must resolve to the higher-
// precedence level, verified BOTH at the resolver (resolveConfigDetailed:
// value + source label) AND through an unstarted daemon's status output
// (the configSources block G5.c owns). Also: the literal 'none' unsets a
// URL key at any level, and the defaultOperator prefill reaches the
// status config block.
//
// 0.4.0 adds the §3.12 `enrich` flag to the matrix. A boolean cannot carry
// four distinct values, so each pair is run in BOTH polarities (winner
// true / loser false, then winner false / loser true): the winning level
// must decide the value in both directions, which is the same claim the
// numeric key proves with distinct values. Also asserted: the default is
// OFF with source 'default', a non-boolean value fails loudly rather than
// silently coercing (KAMI_LENS_ENRICH=1 is an error, not "on"), and both
// status.config.enrich and configSources.enrich reach the status block.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseConfigFlags, resolveConfigDetailed } from '../../src/config';
import { KamiLensDaemon } from '../../src/daemon';
import { buildStatusData } from '../../src/server';
import { ARTIFACTS_DIR, fail, pass, writeMeasurement } from '../g1/lib.mts';

const SCRATCH = path.join(ARTIFACTS_DIR, 'g5c-scratch');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });

const KEY_ENV = 'KAMI_LENS_CHECKPOINT_INTERVAL_MS';
const VALUES = { default: 600_000, file: 111_000, env: 222_000, flag: 333_000 } as const;
type Level = keyof typeof VALUES;

const fileWith = (v: number): string => {
  const p = path.join(SCRATCH, `config-${v}.toml`);
  writeFileSync(p, `checkpoint_interval_ms = ${v}\n`);
  return p;
};
const emptyFile = (): string => {
  const p = path.join(SCRATCH, 'config-empty.toml');
  writeFileSync(p, '# empty\n');
  return p;
};

function resolveWith(levels: Level[]): { value: number; source: string } {
  const withFile = levels.includes('file');
  const flags: Record<string, unknown> = { configFile: withFile ? fileWith(VALUES.file) : emptyFile() };
  if (levels.includes('flag')) flags.checkpointIntervalMs = VALUES.flag;
  const oldEnv = process.env[KEY_ENV];
  if (levels.includes('env')) process.env[KEY_ENV] = String(VALUES.env);
  else delete process.env[KEY_ENV];
  try {
    const { config, sources } = resolveConfigDetailed({}, flags);
    return { value: config.checkpointIntervalMs, source: sources.checkpointIntervalMs };
  } finally {
    if (oldEnv === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = oldEnv;
  }
}

const PAIRS: [Level, Level][] = [
  ['flag', 'env'],
  ['flag', 'file'],
  ['flag', 'default'],
  ['env', 'file'],
  ['env', 'default'],
  ['file', 'default'],
];

const results: Record<string, unknown>[] = [];
let failures = 0;
for (const [winner, loser] of PAIRS) {
  const levels = [winner, loser].filter((l) => l !== 'default') as Level[];
  const got = resolveWith(levels);
  const ok = got.value === VALUES[winner] && got.source === winner;
  if (!ok) failures++;
  results.push({ pair: `${winner}>${loser}`, expected: VALUES[winner], got, ok });
}

// --- §3.12 enrich: boolean pairwise, both polarities ------------------------
function resolveEnrich(levels: Partial<Record<Level, boolean>>): { value: boolean; source: string } {
  const flags: Record<string, unknown> = {};
  if ('file' in levels) {
    const fp = path.join(SCRATCH, `enrich-${String(levels.file)}.toml`);
    writeFileSync(fp, `enrich = ${String(levels.file)}\n`);
    flags.configFile = fp;
  } else {
    flags.configFile = emptyFile();
  }
  if ('flag' in levels) flags.enrich = levels.flag;
  const oldEnv = process.env.KAMI_LENS_ENRICH;
  if ('env' in levels) process.env.KAMI_LENS_ENRICH = String(levels.env);
  else delete process.env.KAMI_LENS_ENRICH;
  try {
    const { config, sources } = resolveConfigDetailed({}, flags);
    return { value: config.enrich, source: sources.enrich };
  } finally {
    if (oldEnv === undefined) delete process.env.KAMI_LENS_ENRICH;
    else process.env.KAMI_LENS_ENRICH = oldEnv;
  }
}

const enrichResults: Record<string, unknown>[] = [];
let enrichFailures = 0;
{
  // default: OFF, and provenance says so
  const dflt = resolveEnrich({});
  const dfltOk = dflt.value === false && dflt.source === 'default';
  if (!dfltOk) enrichFailures++;
  enrichResults.push({ case: 'default', expected: false, got: dflt, ok: dfltOk });

  for (const [winner, loser] of PAIRS) {
    for (const winnerValue of [true, false]) {
      const levels: Partial<Record<Level, boolean>> = { [winner]: winnerValue };
      if (loser !== 'default') levels[loser] = !winnerValue;
      const got = resolveEnrich(levels);
      const ok = got.value === winnerValue && got.source === winner;
      if (!ok) enrichFailures++;
      enrichResults.push({
        case: `${winner}(${String(winnerValue)})>${loser}`,
        expected: winnerValue,
        got,
        ok,
      });
    }
  }

  // a non-boolean must fail loudly — the family's flag is `=true`, not `=1`
  let looseRejected = false;
  process.env.KAMI_LENS_ENRICH = '1';
  try {
    resolveConfigDetailed({}, { configFile: emptyFile() });
  } catch {
    looseRejected = true;
  } finally {
    delete process.env.KAMI_LENS_ENRICH;
  }
  if (!looseRejected) enrichFailures++;
  enrichResults.push({ case: "env '1' rejected", expected: true, got: looseRejected, ok: looseRejected });
}

// the same provenance through an unstarted daemon's status block
process.env[KEY_ENV] = String(VALUES.env);
let statusOk = false;
let statusDetail: Record<string, unknown> = {};
try {
  const daemon = new KamiLensDaemon(
    { dataDir: path.join(SCRATCH, 'void-data') },
    {
      configFile: fileWith(VALUES.file),
      checkpointIntervalMs: VALUES.flag,
      defaultOperator: 2160,
      enrich: true,
    }
  );
  const status = buildStatusData(daemon);
  const config = status.config as {
    checkpointIntervalMs: number;
    defaultOperator?: number;
    enrich?: boolean;
  };
  const sources = status.configSources as Record<string, string>;
  statusDetail = {
    checkpointIntervalMs: config.checkpointIntervalMs,
    source: sources.checkpointIntervalMs,
    defaultOperator: config.defaultOperator,
    configFile: status.configFile,
    enrich: config.enrich,
    enrichSource: sources.enrich,
  };
  statusOk =
    config.checkpointIntervalMs === VALUES.flag &&
    sources.checkpointIntervalMs === 'flag' &&
    config.defaultOperator === 2160 &&
    typeof status.configFile === 'string' &&
    // §3.12: the flag is visible in status whether it is on or off, with the
    // level that decided it (here: the flag layer)
    config.enrich === true &&
    sources.enrich === 'flag';
} finally {
  delete process.env[KEY_ENV];
}

// 'none' unsets a URL key at the winning level — go through the real flag
// parser (--kamiden-url none), exactly what the CLI does
const noneParsed = parseConfigFlags(['--kamiden-url', 'none', '--config', emptyFile()]);
const { config: noneCfg, sources: noneSources } = resolveConfigDetailed({}, noneParsed.flags);
const noneOk = noneCfg.kamidenUrl === undefined && noneSources.kamidenUrl === 'flag';

await writeMeasurement('g5c-config', {
  pairs: results,
  enrichPairs: enrichResults,
  statusIntegration: { ok: statusOk, ...statusDetail },
  noneSemantics: { ok: noneOk, kamidenUrl: noneCfg.kamidenUrl ?? null, source: noneSources.kamidenUrl },
  match: failures === 0 && enrichFailures === 0 && statusOk && noneOk,
});
if (failures > 0 || enrichFailures > 0 || !statusOk || !noneOk) {
  fail('G5.c', { results, enrichResults, enrichFailures, statusOk, statusDetail, noneOk });
}
pass('G5.c', {
  pairs: results.length,
  enrichPairs: enrichResults.length,
  statusIntegration: true,
  noneSemantics: true,
});
process.exit(0);
