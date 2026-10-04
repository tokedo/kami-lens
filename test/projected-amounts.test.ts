// 1.0.2 (B4): a projected amount is never negative on output.
//
// The harvest projection computes accrual as the stored balance plus
// floor(elapsed × rate), with elapsed = clock.now() − the harvest's last
// update. With the projection clock behind the chain, a harvest that started
// in the last block or two has a NEGATIVE elapsed time, and `musu.accrued`
// read −1 (a live session on 2026-10-04, one block after a harvest start).
// 1.0.2's clock shrinks that window to about a second; it does not remove it.
// Every amount the same projection produces inherits the sign: the
// liquidation preview's salvage and spoils are shares of that accrual, and
// recoil is the strain of the spoils. None of them can be negative on the
// chain, so the QUERY layer clamps them at 0 on output; the ported projection
// is untouched.

import Ajv from 'ajv/dist/2020';
import { beforeEach, describe, expect, it } from 'vitest';

import * as clock from 'clock';
import { loadSchema, serveQuery } from '../src/queries';
import { addAccount, addKami, makeMirror } from './support/mirror';

const ajv = new Ajv({ strict: true, allErrors: true });
for (const q of ['kami', 'party', 'node'] as const) ajv.addSchema(loadSchema(q), q);

const nowSec = () => Math.floor(Date.now() / 1000);

type Liq = { spoils: number; salvage: number; recoil: number };
type NodeRow = { kami: { index: number }; vitals: { musuAccrued: number }; liquidation: Liq };

/** A harvest that started `lag` seconds AFTER the projection clock's now —
 * i.e. the clock is `lag` seconds behind the chain — plus an attacker on the
 * same node and an account owning the harvester. */
async function answers(lag: number) {
  const m = makeMirror(5_000);
  const t = nowSec();
  addKami(m, { index: 801, state: 'HARVESTING', node: 41, lastTime: t + lag });
  addKami(m, { index: 802, state: 'HARVESTING', node: 41, lastTime: t - 600 });
  addAccount(m, 88, [801]);
  clock.observeBlockTimestamp(t); // the projection clock reads t
  const serve = (q: string, a: string[]) => serveQuery(m, q, a, { stale: false, mode: 'daemon' });
  const kami = await serve('kami', ['801']);
  const party = await serve('party', ['88']);
  const node = await serve('node', ['41', '802', '--with-vitals']);
  const row = (node.data as { harvests: NodeRow[] }).harvests.find((r) => r.kami.index === 801)!;
  return {
    kami: kami.data as { musu: { accrued: number } },
    party: party.data as { kamis: { musu: { accrued: number } }[] },
    node: node.data,
    row,
  };
}

beforeEach(() => clock.reset());

describe('1.0.2 (B4): projected amounts are clamped at 0', () => {
  it('one block after a harvest start, with the clock 2 s behind: accrued and salvage read 0, not −1', async () => {
    const a = await answers(2);
    expect(a.kami.musu.accrued).toBe(0);
    expect(a.party.kamis[0]!.musu.accrued).toBe(0);
    expect(a.row.vitals.musuAccrued).toBe(0);
    expect(a.row.liquidation.salvage).toBe(0);
    expect(a.row.liquidation.spoils).toBe(0);
  });

  it('an hour behind: every amount of that projection reads 0 (spoils, salvage, recoil included)', async () => {
    const a = await answers(3_600);
    expect(a.kami.musu.accrued).toBe(0);
    expect(a.party.kamis[0]!.musu.accrued).toBe(0);
    expect(a.row.vitals.musuAccrued).toBe(0);
    expect(a.row.liquidation).toMatchObject({ spoils: 0, salvage: 0, recoil: 0 });
    expect(ajv.validate('kami', a.kami), ajv.errorsText(ajv.errors)).toBe(true);
    expect(ajv.validate('party', a.party), ajv.errorsText(ajv.errors)).toBe(true);
    expect(ajv.validate('node', a.node), ajv.errorsText(ajv.errors)).toBe(true);
  });

  it('a positive accrual is served as it was (the clamp only floors)', async () => {
    const m = makeMirror(5_000);
    const t = nowSec();
    addKami(m, { index: 811, state: 'HARVESTING', node: 42, lastTime: t - 3_600 });
    clock.observeBlockTimestamp(t);
    const env = await serveQuery(m, 'kami', ['811'], { stale: false, mode: 'daemon' });
    expect((env.data as { musu: { accrued: number } }).musu.accrued).toBeGreaterThan(0);
  });

  it('the schemas state the floor', () => {
    const kami = loadSchema('kami') as { $defs: Record<string, { properties: Record<string, unknown> }> };
    const node = loadSchema('node') as { $defs: Record<string, { properties: Record<string, unknown> }> };
    const party = loadSchema('party') as { $defs: Record<string, { properties: Record<string, unknown> }> };
    const find = (schema: { $defs: Record<string, { properties?: Record<string, unknown> }> }, key: string) =>
      JSON.stringify(schema).includes(`"${key}":{"type":"number","minimum":0`) ||
      JSON.stringify(schema).includes(`"${key}":{"type":"integer","minimum":0`);
    expect(find(kami, 'accrued')).toBe(true);
    expect(find(party, 'accrued')).toBe(true);
    for (const key of ['musuAccrued', 'spoils', 'salvage', 'recoil']) expect(find(node, key)).toBe(true);
  });
});
