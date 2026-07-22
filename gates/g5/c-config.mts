// Gate G5.c [hermetic] — config precedence matrix (DESIGN §5). One key
// (checkpoint_interval_ms) is set at all four levels with distinct
// values; every pairwise combination must resolve to the higher-
// precedence level, verified BOTH at the resolver (resolveConfigDetailed:
// value + source label) AND through an unstarted daemon's status output
// (the configSources block G5.c owns). Also: the literal 'none' unsets a
// URL key at any level, and the defaultOperator prefill reaches the
// status config block.

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

// the same provenance through an unstarted daemon's status block
process.env[KEY_ENV] = String(VALUES.env);
let statusOk = false;
let statusDetail: Record<string, unknown> = {};
try {
  const daemon = new KamiLensDaemon(
    { dataDir: path.join(SCRATCH, 'void-data') },
    { configFile: fileWith(VALUES.file), checkpointIntervalMs: VALUES.flag, defaultOperator: 2160 }
  );
  const status = buildStatusData(daemon);
  const config = status.config as { checkpointIntervalMs: number; defaultOperator?: number };
  const sources = status.configSources as Record<string, string>;
  statusDetail = {
    checkpointIntervalMs: config.checkpointIntervalMs,
    source: sources.checkpointIntervalMs,
    defaultOperator: config.defaultOperator,
    configFile: status.configFile,
  };
  statusOk =
    config.checkpointIntervalMs === VALUES.flag &&
    sources.checkpointIntervalMs === 'flag' &&
    config.defaultOperator === 2160 &&
    typeof status.configFile === 'string';
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
  statusIntegration: { ok: statusOk, ...statusDetail },
  noneSemantics: { ok: noneOk, kamidenUrl: noneCfg.kamidenUrl ?? null, source: noneSources.kamidenUrl },
  match: failures === 0 && statusOk && noneOk,
});
if (failures > 0 || !statusOk || !noneOk) {
  fail('G5.c', { results, statusOk, statusDetail, noneOk });
}
pass('G5.c', { pairs: results.length, statusIntegration: true, noneSemantics: true });
process.exit(0);
