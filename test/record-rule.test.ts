// 1.2.0: live gate records hold aggregates only (gates/g1/record-rule.mts,
// applied by writeMeasurement and by G9's writer to every record they write).
// Synthetic values.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { REPO_ROOT, writeMeasurement } from '../gates/g1/lib.mts';
import { aggregatesOnly, textAllowed } from '../gates/g1/record-rule.mts';
import { writeG9Record } from '../gates/g9/record.mts';

const HEX64 = '0x' + '5e'.repeat(32);
const HEX40 = '0x' + '4d'.repeat(20);
const WORLD = '0x2729174c265dbBd8416C6449E0E813E88f43D0E7';
const PIN = '1b0b34e58537fca324c65237c1a056495c95892e';

describe('the record rule', () => {
  const record = {
    gate: 'G2.x',
    pinnedBlock: 123,
    version: '1.2.0',
    match: true,
    sampled: 3,
    kamisSampled: 3, // a count under an identity-like key survives
    rows: [
      { index: 11, band: 'a', power: 20 },
      { index: 12, band: 'b', power: 30 },
      { index: 13, band: 'c', power: 40 },
    ],
    rejections: [{ screenshot: 'x.png', reason: 'r', basis: { timeLast: 1784587404 } }],
    kamiIndex: 77,
    attacker: { index: 5, name: 'k' },
    attackerKamiIndex: 6,
    config: { defaultOperator: 2160, ok: true },
    ownerAddress: '0x' + 'ab'.repeat(20),
    accountName: 'someone',
    harvestId: '0x' + '12'.repeat(32),
    displayedKamiIndices: [1, 2],
    probe: { id: '0x' + '34'.repeat(32), ok: true, entityIds: ['0x' + '56'.repeat(32)] },
    mismatches: [{ path: 'power', was: 1, now: 2, kamiIndex: 9, entity: '0x' + '78'.repeat(32), timeLast: 1784587404, at: { block: 5 } }],
    getterAddress: '0x991db571eafa031624a0bb11bf48341b15b822a6',
    worldAddress: WORLD,
    pin: PIN,
  };
  const out = aggregatesOnly(record) as Record<string, unknown>;
  const text = JSON.stringify(out);

  it('a list of rows becomes how many rows were compared', () => {
    expect(out.rows).toBe(3);
    expect(out.rejections).toBe(1);
  });
  it('no kami, account, owner, operator, harvest or entity identity survives, at any depth', () => {
    for (const k of ['kamiIndex', 'attacker', 'attackerKamiIndex', 'ownerAddress', 'accountName', 'harvestId', 'displayedKamiIndices']) expect(out).not.toHaveProperty(k);
    expect(out.config).toEqual({ ok: true });
    expect(out.probe).toEqual({ ok: true });
    expect(text).not.toMatch(/0x(ab){20}|someone|(12){32}|(34){32}|(56){32}|(78){32}|1784587404/);
  });
  it('a mismatch keeps its field and its two values, nothing else', () => {
    expect(out.mismatches).toEqual([{ path: 'power', was: 1, now: 2 }]);
  });
  it('counts, the block, the version, the verdict and the listed public constants stay', () => {
    expect(out).toMatchObject({ gate: 'G2.x', pinnedBlock: 123, version: '1.2.0', match: true, sampled: 3, kamisSampled: 3 });
    expect(out).toMatchObject({ getterAddress: '0x991db571eafa031624a0bb11bf48341b15b822a6', worldAddress: WORLD, pin: PIN });
  });
  it('a 64-hex or a 40-hex under a neutral key, or in a plain list, is dropped', () => {
    const o = aggregatesOnly({ checksum: HEX64, ref: HEX40, bare: HEX64.slice(2), list: [HEX64, 'kept'], inText: `read ${HEX40} at head`, n: 1 });
    expect(o).toEqual({ list: ['kept'], n: 1 });
  });
  it('an identity used as an object key is not published', () => {
    const o = aggregatesOnly({ bySheet: { '7799': { ok: true }, '8800': { ok: false } }, byAddress: { [HEX40]: 3 }, byName: { 'kami 12': 1, fine: 2 } }) as Record<string, unknown>;
    expect(o.bySheet).toBe(2);
    expect(o.byAddress).toBe(1);
    expect(o.byName).toEqual({ fine: 2 });
    expect(JSON.stringify(o)).not.toMatch(/7799|8800|(4d){20}|kami 12/);
  });
  it('a list of numbers is published as its length unless it is a named series', () => {
    const o = aggregatesOnly({ sampleIndices: [7799, 8800, 9911], deltas: [0, 1, 0] });
    expect(o).toEqual({ sampleIndices: 3, deltas: [0, 1, 0] });
  });
  it('a note naming an entity by its number is dropped; a fixed note stays', () => {
    const o = aggregatesOnly({
      note: 'a false phantom (kami 7799: INACTIVE at head-90)',
      other: 'account #12 was read twice',
      third: 'operator index: 4',
      fixed: 'a false phantom (one kami: INACTIVE at head-90); 21 sheets, 6 kamis',
    });
    expect(o).toEqual({ fixed: 'a false phantom (one kami: INACTIVE at head-90); 21 sheets, 6 kamis' });
    expect(textAllowed('kami 7799')).toBe(false);
  });
  it('the time of an on-chain action is not published; a gate clock is', () => {
    const o = aggregatesOnly({ startTime: 1790901774, timeEnd: '1790944974', oldestTradeMs: 1784745321673, series: [3, 1790901774], clockPinSec: 1755000000, nowMs: 1784745321673, n: 5 });
    expect(o).toEqual({ series: 2, clockPinSec: 1755000000, nowMs: 1784745321673, n: 5 });
  });
  it('is idempotent', () => {
    expect(aggregatesOnly(out)).toEqual(out);
  });
});

describe('both record writers apply the rule', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kami-lens-records-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const data = {
    match: true,
    rowsCompared: 2,
    rows: [{ kamiIndex: 7799, power: 1 }, { kamiIndex: 8800, power: 2 }],
    checksum: HEX64,
    ref: HEX40,
    bySheet: { '7799': 1 },
    sampleIndices: [7799, 8800],
    note: 'kami 7799 diverged',
  };
  const check = (file: string) => {
    const text = readFileSync(file, 'utf8');
    const o = JSON.parse(text) as Record<string, unknown>;
    expect(o).toMatchObject({ match: true, rowsCompared: 2, rows: 2, bySheet: 1, sampleIndices: 2 });
    expect(o).not.toHaveProperty('checksum');
    expect(o).not.toHaveProperty('ref');
    expect(o).not.toHaveProperty('note');
    expect(text).not.toMatch(/7799|8800|(5e){32}|(4d){20}/);
    return o;
  };

  it('writeMeasurement', async () => {
    const file = await writeMeasurement('gx-rule', data, { dir });
    const o = check(file);
    // the build is named by version and upstream pin, never by a commit
    expect(Object.keys(o.lens as object).sort()).toEqual(['upstream', 'version']);
  });
  it("G9's writer", () => {
    check(writeG9Record({ gate: 'g9a-prelive-stall', ...data }, { dir }));
  });
  it('no gate writes a record into docs/measurements/ except through the two writers', () => {
    const writers = new Set(['g1/lib.mts', 'g9/record.mts', 'g1/rewrite-records.mts']);
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (!e.name.startsWith('.') && e.name !== 'fixtures') walk(p);
        } else if (e.name.endsWith('.mts')) {
          const rel = path.relative(path.join(REPO_ROOT, 'gates'), p);
          const src = readFileSync(p, 'utf8');
          if (!writers.has(rel) && /MEASUREMENTS_DIR|'measurements'/.test(src) && /writeFile/.test(src)) offenders.push(rel);
        }
      }
    };
    walk(path.join(REPO_ROOT, 'gates'));
    expect(offenders).toEqual([]);
    expect(readFileSync(path.join(REPO_ROOT, 'gates', 'g9', 'a-prelive-stall.mts'), 'utf8')).toMatch(/writeG9Record\(record\)/);
  });
});
