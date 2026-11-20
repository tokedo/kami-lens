// 1.2.0: the harvest multiplier K (upstream 8222ff27, deployed 2026-11-09).
//
// Every node stores K, per mille, in the low 16 bits of its
// HarvestMultiplier (LibNode; 1000 = ×1.0, the registry writes 100..60000).
// A harvest copies its node's K when its stretch opens (LibHarvest.start, and
// again after every sync), and a sync credits today's bounty times the COPY,
// rounded to the nearest whole unit:
//
//   credit = (bounty · K + 500) / 1000          LibHarvest.calcCredit
//
// where `bounty` is today's LibHarvest.calcBounty (capped by the HP the kami
// has) and K is the harvest's copy — or, for a harvest from before K (no
// copy), its node's current K (LibHarvest.getCopy). The HP strain is charged
// on the WHOLE base bounty: LibHarvest.sync still returns calcBounty, and
// LibKami._sync strains that. So K moves what a kami has accrued (and so a
// liquidation's salvage and spoils, which are shares of the stored balance)
// and never its HP.
//
// The values here are synthetic; every K the live world carried when this was
// written was 1000, which is why 1.1.1's answers were right without K.

import Ajv from 'ajv/dist/2020';
import { beforeEach, describe, expect, it } from 'vitest';

import * as clock from 'clock';
import { loadSchema, serveQuery } from '../src/queries';
import { addAccount, addKami, addNode, makeMirror, type SyntheticMirror } from './support/mirror';

const ajv = new Ajv({ strict: true, allErrors: true });
for (const q of ['kami', 'party', 'node'] as const) ajv.addSchema(loadSchema(q), q);
const valid = (q: string, d: unknown) => {
  const ok = ajv.validate(q, d);
  if (!ok) throw new Error(`${q} schema: ${ajv.errorsText(ajv.errors)}`);
  return ok;
};

const T = 1_790_000_000;
const serve = (m: SyntheticMirror, q: string, a: string[]) =>
  serveQuery(m, q, a, { stale: false, mode: 'daemon' });

type Vitals = {
  hp: { current: number };
  musu: { accrued: number; spotRatePerHr: string; avgRatePerHr: string };
};
type Row = {
  kami: { index: number };
  vitals: { musuAccrued: number };
  liquidation: { salvage: number; spoils: number };
};

/** one harvesting kami on node 30, an hour in, with an attacker beside it */
function world(opts: { nodeK: number | null; copy?: number; balance?: number }) {
  const m = makeMirror(8_000);
  addNode(m, 30, undefined, { multiplier: opts.nodeK });
  addKami(m, {
    index: 701,
    state: 'HARVESTING',
    node: 30,
    lastTime: T - 3_600,
    hp: { base: 400, sync: 400 },
    harvestK: opts.copy,
    balance: opts.balance,
  });
  addKami(m, { index: 702, state: 'HARVESTING', node: 30, lastTime: T - 600 });
  addAccount(m, 77, [701]);
  clock.observeBlockTimestamp(T);
  return m;
}

/** LibHarvest.calcCredit */
const credit = (bounty: number, k: number) => Number((BigInt(bounty) * BigInt(k) + 500n) / 1000n);

beforeEach(() => clock.reset());

describe('1.2.0: the node answer names its K', () => {
  it('harvestMultiplier is the node entity\'s stored K, the chain\'s integer, LAST on the object', async () => {
    for (const k of [100, 800, 1000, 2500, 60000]) {
      const m = world({ nodeK: k });
      for (const args of [['30'], ['30', '--full'], ['30', '702', '--with-vitals']]) {
        const d = (await serve(m, 'node', args)).data as Record<string, unknown>;
        expect(d.harvestMultiplier).toBe(k);
        expect(Object.keys(d).at(-1)).toBe('harvestMultiplier');
        expect(valid('node', d)).toBe(true);
      }
    }
  });

  it('only the low 16 bits are K (LibNode.getBaseMultiplier reads uint16)', async () => {
    const m = makeMirror(8_000);
    // a raw value with bits above the low 16 set
    addNode(m, 31, undefined, { multiplier: (5 << 16) | 1500 });
    const d = (await serve(m, 'node', ['31'])).data as { harvestMultiplier: number };
    expect(d.harvestMultiplier).toBe(1500);
  });

  it('a node the mirror holds no K for is refused INCOMPLETE, never served with a guessed K', async () => {
    const m = world({ nodeK: null });
    await expect(serve(m, 'node', ['30'])).rejects.toMatchObject({ code: 'INCOMPLETE' });
  });
});

describe('1.2.0: accrued amounts are credited through K; HP is not', () => {
  it('K = 1000 credits the bounty unchanged', async () => {
    const a = (await serve(world({ nodeK: 1000 }), 'kami', ['701'])).data as Vitals;
    expect(a.musu.accrued).toBeGreaterThan(0);
  });

  it.each([100, 1500, 2000, 60000])('the harvest\'s copy K = %i: accrued = (bounty × K + 500) / 1000', async (k) => {
    const base = (await serve(world({ nodeK: 1000 }), 'kami', ['701'])).data as Vitals;
    // the node's K differs from the copy: the copy is what the stretch pays
    const m = world({ nodeK: 700, copy: k });
    const kami = (await serve(m, 'kami', ['701'])).data as Vitals;
    expect(kami.musu.accrued).toBe(credit(base.musu.accrued, k));
    // HP strain is on the whole base bounty
    expect(kami.hp.current).toBe(base.hp.current);
    expect(valid('kami', kami)).toBe(true);
    // the same value on every surface that serves it
    const party = (await serve(m, 'party', ['77'])).data as { kamis: Vitals[] };
    expect(party.kamis[0]!.musu.accrued).toBe(kami.musu.accrued);
    const node = (await serve(m, 'node', ['30', '702', '--with-vitals'])).data as { harvests: Row[] };
    expect(node.harvests.find((r) => r.kami.index === 701)!.vitals.musuAccrued).toBe(kami.musu.accrued);
  });

  it('a harvest from before K (no copy) pays its node\'s current K', async () => {
    const base = (await serve(world({ nodeK: 1000 }), 'kami', ['701'])).data as Vitals;
    const kami = (await serve(world({ nodeK: 2500 }), 'kami', ['701'])).data as Vitals;
    expect(kami.musu.accrued).toBe(credit(base.musu.accrued, 2500));
    expect(kami.hp.current).toBe(base.hp.current);
  });

  it('rounds to the NEAREST unit, half up, on top of the stored balance', async () => {
    // a balance already credited is not re-scaled; only the new stretch is
    const base = (await serve(world({ nodeK: 1000, balance: 1234 }), 'kami', ['701'])).data as Vitals;
    const bounty = base.musu.accrued - 1234;
    const kami = (await serve(world({ nodeK: 1000, copy: 1500, balance: 1234 }), 'kami', ['701'])).data as Vitals;
    expect(kami.musu.accrued).toBe(1234 + credit(bounty, 1500));
  });

  it('the MUSU rates are the credited rates: K = 2000 doubles them', async () => {
    const base = (await serve(world({ nodeK: 1000 }), 'kami', ['701'])).data as Vitals;
    const kami = (await serve(world({ nodeK: 1000, copy: 2000 }), 'kami', ['701'])).data as Vitals;
    const num = (s: string) => Number(s.replace(/[^0-9.-]/g, ''));
    expect(num(kami.musu.avgRatePerHr)).toBeCloseTo(2 * num(base.musu.avgRatePerHr), 1);
    expect(num(kami.musu.spotRatePerHr)).toBeCloseTo(2 * num(base.musu.spotRatePerHr), 1);
  });

  it('a liquidation preview\'s salvage and spoils are shares of the credited balance', async () => {
    const rows = async (copy?: number) =>
      ((await serve(world({ nodeK: 1000, copy }), 'node', ['30', '702', '--with-vitals'])).data as { harvests: Row[] })
        .harvests.find((r) => r.kami.index === 701)!;
    const r1 = await rows();
    const r3 = await rows(3000);
    expect(r3.vitals.musuAccrued).toBe(credit(r1.vitals.musuAccrued, 3000));
    expect(r3.liquidation.salvage).toBeGreaterThan(r1.liquidation.salvage);
    expect(r3.liquidation.spoils).toBeGreaterThan(r1.liquidation.spoils);
  });
});

describe('1.2.0: a harvest whose K cannot be resolved is never served as a silent zero', () => {
  // no copy on the harvest and no K on its node: the credit would be
  // (bounty · 0 + 500) / 1000 = 0. Cannot occur on the deployed world (every
  // node has K); a hollow mirror is refused / flagged as any missing join is.
  it('kami refuses INCOMPLETE (missing multiplier)', async () => {
    const m = world({ nodeK: null });
    await expect(serve(m, 'kami', ['701'])).rejects.toMatchObject({ code: 'INCOMPLETE' });
    await expect(serve(m, 'kami', ['701'])).rejects.toThrow(/multiplier/);
  });

  it('party flags the row incomplete: identity and the flag, no vitals', async () => {
    const m = world({ nodeK: null });
    const party = (await serve(m, 'party', ['77'])).data as { kamis: Record<string, unknown>[] };
    expect(party.kamis[0]).toMatchObject({ index: 701, incomplete: true });
    expect(party.kamis[0]!.musu).toBeUndefined();
    expect(valid('party', party)).toBe(true);
  });

  it('a harvest copy alone resolves K (the node\'s K is only the fallback)', async () => {
    const m = world({ nodeK: null, copy: 1500 });
    const kami = (await serve(m, 'kami', ['701'])).data as Vitals;
    expect(kami.musu.accrued).toBeGreaterThan(0);
  });
});

