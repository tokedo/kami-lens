// A1 — one projection point: an incomplete kami is refused on a single-entity
// read and flagged (no vitals, no liquidation) on a list read, counted in
// `meta.incompleteRows` and in the status counter. Driven over the synthetic
// mirror through serveQuery, the entry point the socket, CLI and library
// share.

import Ajv from 'ajv/dist/2020';
import { beforeEach, describe, expect, it } from 'vitest';

import * as clock from 'clock';
import { removeComponent, setComponent } from 'engine/recs';
import { hashArgs } from 'network/shapes/utils';
import { incompleteRowsReport, resetIncompleteRows } from '../src/projection-health';
import { loadSchema, serveQuery } from '../src/queries';
import { addKami, makeMirror, type SyntheticMirror } from './support/mirror';

const nowSec = () => Math.floor(Date.now() / 1000);

// the checked-in schemas, strict — the same validator G3.a uses
const ajv = new Ajv({ strict: true, allErrors: true });
for (const q of ['node', 'party', 'roster', 'kami']) ajv.addSchema(loadSchema(q as never), q);
const valid = (q: string, data: unknown) => {
  const ok = ajv.validate(q, data);
  if (!ok) throw new Error(`${q} schema: ${ajv.errorsText(ajv.errors)}`);
  return ok;
};
const serve = (m: SyntheticMirror, q: string, args: string[]) =>
  serveQuery(m, q, args, { stale: false, mode: 'daemon' });

/** An account owning the given kamis (OwnsKamiID is the kami -> account join). */
function addAccount(m: SyntheticMirror, index: number, kamis: number[]) {
  const { world, components: c } = m;
  const id = hashArgs(['account', index], ['string', 'uint32']);
  const e = world.registerEntity({ id });
  setComponent(c.EntityType, e, { value: 'ACCOUNT' });
  setComponent(c.AccountIndex, e, { value: index });
  setComponent(c.Name, e, { value: `account ${index}` });
  setComponent(c.RoomIndex, e, { value: 1 });
  for (const k of kamis) {
    const ke = world.entityToIndex.get(hashArgs(['kami.id', k], ['string', 'uint32']))!;
    setComponent(c.OwnsKamiID, ke, { value: id });
  }
  return e;
}

beforeEach(() => {
  clock.reset();
  resetIncompleteRows();
});

describe('A1: single-entity reads refuse an incomplete kami', () => {
  it('a kami whose Health component is missing is refused with INCOMPLETE, not served as hp 0/0', async () => {
    const m = makeMirror(2_000);
    const t = nowSec();
    const e = addKami(m, { index: 501, state: 'RESTING', lastTime: t - 600 });
    removeComponent(m.components.Health, e);
    await expect(serve(m, 'kami', ['501'])).rejects.toMatchObject({ code: 'INCOMPLETE' });
    const r = incompleteRowsReport();
    expect(r).toMatchObject({ total: 1, refused: 1, flagged: 0, lastBlock: 2_000 });
    expect(r.lastAt).not.toBeNull();
  });

  it('a HARVESTING kami with no harvest entity (the one-transaction transient) is refused, and says so', async () => {
    const m = makeMirror();
    addKami(m, { index: 502, state: 'HARVESTING', lastTime: nowSec() - 60, withHarvest: false });
    await expect(serve(m, 'kami', ['502'])).rejects.toThrow(/missing harvest.*transient/);
  });

  it('the skills read refuses the same kami', async () => {
    const m = makeMirror();
    const e = addKami(m, { index: 503, state: 'RESTING', lastTime: nowSec() - 60 });
    removeComponent(m.components.Level, e);
    await expect(serve(m, 'skills', ['503'])).rejects.toMatchObject({ code: 'INCOMPLETE' });
  });

  it('an incomplete ATTACKER refuses the pairing read', async () => {
    const m = makeMirror();
    const t = nowSec();
    addKami(m, { index: 504, state: 'HARVESTING', node: 21, lastTime: t - 600 });
    const a = addKami(m, { index: 505, state: 'HARVESTING', node: 21, lastTime: t - 600 });
    removeComponent(m.components.Health, a);
    await expect(serve(m, 'node', ['21', '505', '--with-vitals'])).rejects.toMatchObject({
      code: 'INCOMPLETE',
    });
  });

  it('a complete kami is served and counts nothing', async () => {
    const m = makeMirror();
    addKami(m, { index: 506, state: 'HARVESTING', node: 22, lastTime: nowSec() - 600 });
    const env = await serve(m, 'kami', ['506']);
    expect((env.data as { hp: { total: number } }).hp.total).toBe(100);
    expect(env.meta).not.toHaveProperty('incompleteRows');
    expect(incompleteRowsReport().total).toBe(0);
    expect(valid('kami', env.data)).toBe(true);
  });
});

describe('A1: list reads keep and flag an incomplete row', () => {
  it('node --with-vitals: the row is kept, flagged, with no vitals and no liquidation; meta counts it', async () => {
    const m = makeMirror(3_000);
    const t = nowSec();
    addKami(m, { index: 601, state: 'HARVESTING', node: 31, lastTime: t - 600 });
    const hollow = addKami(m, { index: 602, state: 'HARVESTING', node: 31, lastTime: t - 600 });
    addKami(m, { index: 603, state: 'HARVESTING', node: 31, lastTime: t - 600 });
    removeComponent(m.components.Level, hollow);
    const env = await serve(m, 'node', ['31', '603', '--with-vitals']);
    const rows = (env.data as { harvests: Record<string, unknown>[] }).harvests;
    expect(rows.map((r) => (r.kami as { index: number }).index)).toEqual([601, 602, 603]);
    const flagged = rows[1]!;
    expect(flagged.incomplete).toBe(true);
    expect(flagged).not.toHaveProperty('vitals');
    expect(flagged).not.toHaveProperty('liquidation');
    expect(rows[0]).not.toHaveProperty('incomplete');
    expect(rows[0]).toHaveProperty('vitals');
    expect(rows[0]).toHaveProperty('liquidation');
    expect(env.meta.incompleteRows).toBe(1);
    expect(incompleteRowsReport()).toMatchObject({ total: 1, refused: 0, flagged: 1, lastBlock: 3_000 });
    expect(valid('node', env.data)).toBe(true);
    // ...and the schema REFUSES a flagged row that carries vitals anyway
    const forged = structuredClone(env.data) as { harvests: Record<string, unknown>[] };
    forged.harvests[1]!.vitals = forged.harvests[0]!.vitals;
    expect(ajv.validate('node', forged)).toBe(false);
  });

  it('party and roster: the transient kami is kept and flagged, the answer is not refused', async () => {
    const m = makeMirror();
    const t = nowSec();
    addKami(m, { index: 701, state: 'RESTING', lastTime: t - 600 });
    addKami(m, { index: 702, state: 'HARVESTING', lastTime: t - 60, withHarvest: false });
    addAccount(m, 77, [701, 702]);

    const party = await serve(m, 'party', ['77']);
    const prow = (party.data as { kamis: Record<string, unknown>[] }).kamis;
    expect(prow.map((k) => k.index)).toEqual([701, 702]);
    expect(prow[1]).toMatchObject({ index: 702, state: 'HARVESTING', incomplete: true });
    expect(prow[1]).not.toHaveProperty('hp');
    expect(prow[0]).toHaveProperty('hp');
    expect(party.meta.incompleteRows).toBe(1);
    expect(valid('party', party.data)).toBe(true);

    const roster = await serve(m, 'roster', ['77']);
    const rrow = (roster.data as { kamis: Record<string, unknown>[] }).kamis;
    const r702 = rrow.find((k) => k.index === 702)!;
    expect(r702).toEqual({ index: 702, state: 'HARVESTING', incomplete: true });
    expect(roster.meta.incompleteRows).toBe(1);
    expect(valid('roster', roster.data)).toBe(true);
    expect(incompleteRowsReport()).toMatchObject({ flagged: 2, refused: 0 });
  });
});
