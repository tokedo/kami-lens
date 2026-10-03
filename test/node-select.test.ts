// 1.0.0 (B2): crowded-node reads select BEFORE they project, and the roster's
// --stats cap can be lifted.
//
// The largest node holds four figures of harvests; its whole-node vitals read
// measured ~1.3 MB. A caller that knows which occupants it cares about (its
// targets, or one account's kamis) now names them with `--targets` /
// `--account` and pays for exactly those rows. `harvestsTotal` keeps
// reporting the WHOLE node; `harvestsSelected` says what the selector kept;
// `targetsAbsent` says which requested kamis are not on the node at all.

import Ajv from 'ajv/dist/2020';
import { beforeEach, describe, expect, it } from 'vitest';

import * as clock from 'clock';
import { removeComponent } from 'engine/recs';
import { hashArgs } from 'network/shapes/utils';
import { resetIncompleteRows } from '../src/projection-health';
import { loadSchema, serveQuery } from '../src/queries';
import { REGISTRY } from '../src/queries/registry';
import { addAccount, addKami, makeMirror, type SyntheticMirror } from './support/mirror';

const nowSec = () => Math.floor(Date.now() / 1000);
const ajv = new Ajv({ strict: true, allErrors: true });
for (const q of ['node', 'roster']) ajv.addSchema(loadSchema(q as never), q);
const valid = (q: string, data: unknown) => {
  const ok = ajv.validate(q, data);
  if (!ok) throw new Error(`${q} schema: ${ajv.errorsText(ajv.errors)}`);
  return ok;
};
const serve = (m: SyntheticMirror, q: string, args: string[]) =>
  serveQuery(m, q, args, { stale: false, mode: 'daemon' });

type NodeData = {
  harvestsTotal: number;
  harvestsSelected?: number;
  harvestsEligible?: number;
  harvestsServed: number;
  targetsAbsent?: number[];
  harvests: {
    kami: { index: number };
    account: { index: number };
    vitals?: unknown;
  }[];
};

function crowdedNode(): SyntheticMirror {
  const m = makeMirror(5_000);
  const t = nowSec();
  for (const k of [601, 602, 603, 604, 605, 606]) {
    addKami(m, { index: k, state: 'HARVESTING', node: 9, lastTime: t - 900 });
  }
  addAccount(m, 77, [601, 602]);
  addAccount(m, 88, [603]);
  return m;
}

beforeEach(() => {
  clock.reset();
  resetIncompleteRows();
});

describe('node --targets / --account (B2)', () => {
  it('--targets keeps the named occupants, reports the absent ones, keeps the whole-node total', async () => {
    const m = crowdedNode();
    const d = (await serve(m, 'node', ['9', '--targets', '605,601,999'])).data as NodeData;
    expect(d.harvestsTotal).toBe(6);
    expect(d.harvestsSelected).toBe(2);
    expect(d.harvestsServed).toBe(2);
    expect(d.targetsAbsent).toEqual([999]);
    expect(d.harvests.map((h) => h.kami.index)).toEqual([601, 605]);
    expect(valid('node', d)).toBe(true);
  });

  it("--account keeps that account's occupants", async () => {
    const m = crowdedNode();
    const d = (await serve(m, 'node', ['9', '--account', '77'])).data as NodeData;
    expect(d.harvestsSelected).toBe(2);
    expect(d.harvests.map((h) => h.kami.index)).toEqual([601, 602]);
    expect(d.targetsAbsent).toBeUndefined();
    expect(valid('node', d)).toBe(true);
  });

  it('both selectors intersect; targetsAbsent stays about the NODE', async () => {
    const m = crowdedNode();
    const d = (await serve(m, 'node', ['9', '--targets', '601,603', '--account=77']))
      .data as NodeData;
    expect(d.harvests.map((h) => h.kami.index)).toEqual([601]);
    expect(d.harvestsSelected).toBe(1);
    expect(d.targetsAbsent).toEqual([]); // 603 IS on the node, just not account 77's
  });

  it('selection happens BEFORE projection: an unselected incomplete occupant costs nothing', async () => {
    const m = crowdedNode();
    // hollow kami 604 (no Health): a whole-node vitals read flags it…
    const k604 = m.world.entityToIndex.get(hashArgs(['kami.id', 604], ['string', 'uint32']))!;
    removeComponent(m.components.Health, k604);
    const whole = await serve(m, 'node', ['9', '--with-vitals']);
    expect(whole.meta.incompleteRows).toBe(1);
    // …a selected read that does not name it never projects it
    const sel = await serve(m, 'node', ['9', '--with-vitals', '--targets', '601,602']);
    expect(sel.meta.incompleteRows).toBeUndefined();
    const d = sel.data as NodeData;
    expect(d.harvests.every((h) => h.vitals !== undefined)).toBe(true);
    expect(valid('node', d)).toBe(true);
  });

  it('flag-off is unchanged: no selector, no new keys', async () => {
    const m = crowdedNode();
    const d = (await serve(m, 'node', ['9'])).data as Record<string, unknown>;
    expect('harvestsSelected' in d).toBe(false);
    expect('targetsAbsent' in d).toBe(false);
    expect(d.harvestsTotal).toBe(6);
  });

  it('a selector value is never read as the index or the attacker', () => {
    const a = REGISTRY.node.parseArgs(['--targets', '601', '9']);
    expect(a).toMatchObject({ index: 9, targets: [601] });
    expect(a.attacker).toBeUndefined();
  });

  it('refuses a malformed, oversized or repeated --targets', () => {
    const code = (args: string[]) => {
      try {
        REGISTRY.node.parseArgs(args);
        return 'accepted';
      } catch (e) {
        return (e as { code: string }).code;
      }
    };
    expect(code(['9', '--targets', 'a,b'])).toBe('BAD_ARGS');
    expect(code(['9', '--targets', ''])).toBe('BAD_ARGS');
    expect(code(['9', '--targets', Array.from({ length: 501 }, (_, i) => i).join(',')])).toBe(
      'BAD_ARGS'
    );
    expect(code(['9', '--targets', Array.from({ length: 500 }, (_, i) => i).join(',')])).toBe(
      'accepted'
    );
    expect(code(['9', '--targets', '1', '--targets', '2'])).toBe('BAD_ARGS');
    expect(code(['9', '1', '2'])).toBe('BAD_ARGS');
    expect(REGISTRY.node.parseArgs(['9', '--targets', '5,5,6']).targets).toEqual([5, 6]);
  });
});

describe('roster --full (B2)', () => {
  function bigRoster(): SyntheticMirror {
    const m = makeMirror(5_000);
    const t = nowSec();
    const ks = Array.from({ length: 60 }, (_, i) => 1_000 + i);
    for (const k of ks) addKami(m, { index: k, state: 'RESTING', lastTime: t - 60 });
    addAccount(m, 77, ks);
    return m;
  }
  type RosterData = {
    kamis: { index: number }[];
    kamisTotal?: number;
    kamisServed?: number;
  };

  it('--stats caps at 50; --stats --full serves every row, counts beside', async () => {
    const m = bigRoster();
    const capped = (await serve(m, 'roster', ['77', '--stats'])).data as RosterData;
    expect(capped.kamisServed).toBe(50);
    expect(capped.kamisTotal).toBe(60);
    const full = (await serve(m, 'roster', ['77', '--stats', '--full'])).data as RosterData;
    expect(full.kamisServed).toBe(60);
    expect(full.kamisTotal).toBe(60);
    expect(full.kamis.map((k) => k.index)).toEqual(
      [...full.kamis.map((k) => k.index)].sort((a, b) => a - b)
    );
    expect(valid('roster', full)).toBe(true);
  });

  it('without --stats, --full changes nothing (the roster is uncapped already)', async () => {
    const m = bigRoster();
    const plain = (await serve(m, 'roster', ['77'])).data;
    const full = (await serve(m, 'roster', ['77', '--full'])).data;
    expect(full).toEqual(plain);
  });
});
