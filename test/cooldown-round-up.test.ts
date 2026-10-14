// 1.0.5: `cooldownSec` rounds UP.
//
// The ported calcCooldown (app/cache/kami/calcs/base.ts) returns FRACTIONAL
// seconds: max(0, cooldown end − clock.now()/1000). Until 1.0.4 the query
// layer served it rounded DOWN, so a read 0.4 s before the end said
// `cooldownSec: 0` while the chain still refused the action ("kami on
// cooldown"; a live session on 2026-10-04 saw 0 while the chain refused). On
// the same node answer `attacker.blocked` already said ATTACKER_COOLDOWN,
// because onCooldown is calcCooldown > 0 — one answer, two verdicts. Served
// rounded UP, `cooldownSec` is "whole seconds until the chain accepts the next
// standard action; 0 only when the cooldown has ended", and it is > 0 exactly
// when the liquidation gate says the attacker is on cooldown. The ported calc
// is untouched; the three served sites are in queries/build.ts.

import Ajv from 'ajv/dist/2020';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as clock from 'clock';
import { loadSchema, serveQuery } from '../src/queries';
import { addAccount, addKami, makeMirror } from './support/mirror';

const ajv = new Ajv({ strict: true, allErrors: true });
for (const q of ['kami', 'party', 'node'] as const) ajv.addSchema(loadSchema(q), q);

/** The cooldown end, in chain seconds (a whole number, as NextTime is). */
const END = 1_791_997_500;

type Attacker = { cooldownSec: number; blocked: string | null };
type Row = {
  kami: { index: number };
  vitals: { cooldownSec: number };
  liquidation?: { eligible: boolean; reason?: string };
};

/** Every surface that serves `cooldownSec`, read with the projection clock
 * `msBeforeEnd` milliseconds before the cooldown ends: the kami answer, a party
 * row, a node occupant row and the node liquidation preview's attacker. Both
 * kamis on the node share the same cooldown end. */
async function answersAt(msBeforeEnd: number) {
  vi.setSystemTime(END * 1000 - msBeforeEnd);
  const m = makeMirror(5_000);
  addKami(m, { index: 901, state: 'HARVESTING', node: 51, lastTime: END - 200, nextTime: END });
  addKami(m, { index: 902, state: 'HARVESTING', node: 51, lastTime: END - 200, nextTime: END });
  addAccount(m, 88, [901]);
  const serve = (q: string, a: string[]) => serveQuery(m, q, a, { stale: false, mode: 'daemon' });
  const kami = await serve('kami', ['901']);
  const party = await serve('party', ['88']);
  const node = await serve('node', ['51', '902', '--with-vitals']);
  const nodeData = node.data as { attacker: Attacker; harvests: Row[] };
  return {
    kami: kami.data as { cooldownSec: number },
    party: party.data as { kamis: { cooldownSec: number }[] },
    node: node.data,
    attacker: nodeData.attacker,
    occupant: nodeData.harvests.find((r) => r.kami.index === 901)!,
    all: [kami.data, party.data, node.data] as const,
  };
}

/** The four served values, in a fixed order: kami, party row, occupant row,
 * attacker. */
const served = (a: Awaited<ReturnType<typeof answersAt>>) => [
  a.kami.cooldownSec,
  a.party.kamis[0]!.cooldownSec,
  a.occupant.vitals.cooldownSec,
  a.attacker.cooldownSec,
];

beforeEach(() => {
  clock.reset(); // offset 0: the projection clock reads the (fake) wall clock
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  clock.reset();
});

describe('1.0.5: cooldownSec rounds up', () => {
  it('0.4 s before the end: every surface serves 1 (1.0.4 served 0)', async () => {
    const a = await answersAt(400);
    expect(served(a)).toEqual([1, 1, 1, 1]);
  });

  it('59.2 s before the end: every surface serves 60 (1.0.4 served 59)', async () => {
    const a = await answersAt(59_200);
    expect(served(a)).toEqual([60, 60, 60, 60]);
  });

  it('exactly at the end: every surface serves 0', async () => {
    const a = await answersAt(0);
    expect(served(a)).toEqual([0, 0, 0, 0]);
  });

  it('a whole number of seconds left is served as it is (60 s → 60, 1 s → 1)', async () => {
    expect(served(await answersAt(60_000))).toEqual([60, 60, 60, 60]);
    expect(served(await answersAt(1_000))).toEqual([1, 1, 1, 1]);
  });

  it('in the last fraction of a second, cooldownSec > 0 exactly when the liquidation gate says ATTACKER_COOLDOWN', async () => {
    for (const ms of [999, 400, 1]) {
      const a = await answersAt(ms);
      expect(a.attacker.blocked).toBe('ATTACKER_COOLDOWN');
      expect(a.attacker.cooldownSec).toBeGreaterThan(0);
      // the occupant's preview agrees: not eligible, for the attacker's cooldown
      expect(a.occupant.liquidation).toMatchObject({ eligible: false, reason: 'ATTACKER_COOLDOWN' });
    }
    const end = await answersAt(0);
    expect(end.attacker.cooldownSec).toBe(0);
    expect(end.attacker.blocked).not.toBe('ATTACKER_COOLDOWN');
    expect(end.occupant.liquidation?.reason).not.toBe('ATTACKER_COOLDOWN');
  });

  it('every answer validates, and never serves a negative (an hour after the end: 0)', async () => {
    for (const ms of [400, 59_200, 0, -3_600_000]) {
      const a = await answersAt(ms);
      for (const v of served(a)) expect(v).toBeGreaterThanOrEqual(0);
      expect(ajv.validate('kami', a.kami), ajv.errorsText(ajv.errors)).toBe(true);
      expect(ajv.validate('party', a.party), ajv.errorsText(ajv.errors)).toBe(true);
      expect(ajv.validate('node', a.node), ajv.errorsText(ajv.errors)).toBe(true);
    }
  });

  it('the schemas state the floor and the meaning on all four cooldownSec entries', () => {
    const entries = (schema: unknown) => {
      const out: { type?: unknown; minimum?: unknown; description?: unknown }[] = [];
      const walk = (n: unknown) => {
        if (n === null || typeof n !== 'object') return;
        for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
          if (k === 'cooldownSec' && v !== null && typeof v === 'object') out.push(v as never);
          walk(v);
        }
      };
      walk(schema);
      return out;
    };
    const found = [
      ...entries(loadSchema('kami')),
      ...entries(loadSchema('node')),
      ...entries(loadSchema('party')),
    ];
    expect(found).toHaveLength(4);
    for (const e of found) {
      expect(e.type).toBe('number');
      expect(e.minimum).toBe(0);
      expect(String(e.description)).toContain(
        'whole seconds until the chain accepts the next standard action; 0 only when the cooldown has ended'
      );
    }
    // the same string check test/projected-amounts.test.ts uses for the 1.0.2 floors
    const find = (schema: unknown) =>
      JSON.stringify(schema).includes('"cooldownSec":{"type":"number","minimum":0');
    expect(find(loadSchema('kami'))).toBe(true);
    expect(find(loadSchema('node'))).toBe(true);
    expect(find(loadSchema('party'))).toBe(true);
  });
});
