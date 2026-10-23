// 1.1.0 (§3.19): the node read names its yield item, its requirements, its
// level cap and its scavenge cost.
//
// The vendored Node shape (network/shapes/Node/types.ts getNode) has always
// read all three facts from the mirror — `drops: [getItemByIndex(ItemIndex)]`,
// `requirements: getRequirements(nodeIndex)` (the CONDITION entities under
// hash("node.requirement", index)), `scavenge: getScavenge(registry entity)` —
// and `node` served none of them. A reader deciding where to harvest could
// not learn which item a node pays, what level the node admits, or what a
// scavenge tier costs there, without a catalog the lens does not ship.
//
// THE LEVEL LIMIT IS A MAXIMUM. The deploy writes it as
// `requirement.add(index, 'LEVEL', 'CURR_MAX', 0, limit, 'KAMI')`
// (contracts deployment/world/state/rooms/nodes.ts addRequirement), and
// LibConditional reads CURR_MAX as "current value <= target"; HarvestStart
// reverts "node reqs not met" otherwise. The convenience field is therefore
// `levelCap` — the client's map reads the same condition as a level cap.
//
// A node whose yield item or scavenge registry entry the mirror lacks is an
// INCOMPLETE projection (every node has both at the pin): refused, never
// served with a hollow field — the 1.0.0 A1 rule.

import Ajv from 'ajv/dist/2020';
import { beforeEach, describe, expect, it } from 'vitest';

import * as clock from 'clock';
import { incompleteRowsReport, resetIncompleteRows } from '../src/projection-health';
import { loadSchema, serveQuery } from '../src/queries';
import { addKami, addNode, addNodeCondition, makeMirror, type SyntheticMirror } from './support/mirror';

const ajv = new Ajv({ strict: true, allErrors: true });
ajv.addSchema(loadSchema('node'), 'node');
const valid = (data: unknown) => {
  const ok = ajv.validate('node', data);
  if (!ok) throw new Error(`node schema: ${ajv.errorsText(ajv.errors)}`);
  return ok;
};
const serve = (m: SyntheticMirror, args: string[]) =>
  serveQuery(m, 'node', args, { stale: false, mode: 'daemon' });

type NodeFacts = {
  yieldItem: { index: number; name: string };
  requirements: { logic: string; type: string; index?: number; value?: string; for?: string }[];
  levelCap: number | null;
  scavengeCost: number;
  scavengeAffinity?: string;
};

const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  clock.reset();
  resetIncompleteRows();
});

describe('1.1.0: node serves its yield item, requirements, level cap and scavenge cost', () => {
  it('a VIPP node with no limit (the node-52 shape): yieldItem {2, VIPP}, no requirement, cost 300', async () => {
    const m = makeMirror(7_000);
    addNode(m, 52, undefined, { item: 2, itemName: 'VIPP', scavCost: 300, affinity: 'EERIE' });
    const d = (await serve(m, ['52'])).data as NodeFacts;
    expect(d.yieldItem).toEqual({ index: 2, name: 'VIPP' });
    expect(d.requirements).toEqual([]);
    expect(d.levelCap).toBeNull();
    expect(d.scavengeCost).toBe(300);
    expect(d.scavengeAffinity).toBe('EERIE');
    expect(valid(d)).toBe(true);
  });

  it('a node with a level limit of 35 (the node-59 shape): the condition as stored, and levelCap 35', async () => {
    const m = makeMirror(7_000);
    addNode(m, 59, undefined, { item: 1, itemName: 'MUSU', scavCost: 200, levelLimit: 35 });
    const d = (await serve(m, ['59'])).data as NodeFacts;
    expect(d.yieldItem).toEqual({ index: 1, name: 'MUSU' });
    // value verbatim as the mirror decodes the uint256 (35 = 0x23); no
    // `index` key, because LibConditional.create stores no Index when it is 0
    expect(d.requirements).toEqual([{ logic: 'CURR_MAX', type: 'LEVEL', value: '0x23', for: 'KAMI' }]);
    expect(d.levelCap).toBe(35);
    expect(d.scavengeCost).toBe(200);
    expect(valid(d)).toBe(true);
  });

  it('the fixture facts of node 1 (limit 15, cost 100) and node 16 (cost 1,000)', async () => {
    const m = makeMirror(7_000);
    addNode(m, 1, undefined, { levelLimit: 15, affinity: 'EERIE' });
    addNode(m, 16, undefined, { scavCost: 1_000, affinity: 'EERIE-SCRAP' });
    const n1 = (await serve(m, ['1'])).data as NodeFacts;
    expect(n1.yieldItem.name).toBe('MUSU');
    expect(n1.levelCap).toBe(15);
    expect(n1.scavengeCost).toBe(100);
    const n16 = (await serve(m, ['16'])).data as NodeFacts;
    expect(n16.levelCap).toBeNull();
    expect(n16.scavengeCost).toBe(1_000);
    expect(n16.scavengeAffinity).toBe('EERIE-SCRAP');
  });

  it('levelCap reads only LEVEL/CURR_MAX on the kami, and the lowest of several', async () => {
    const m = makeMirror(7_000);
    addNode(m, 70);
    // a MINIMUM is a requirement but not a cap
    addNodeCondition(m, 70, { type: 'LEVEL', logic: 'CURR_MIN', value: 10, for: 'KAMI' }, 1);
    // a cap on the ACCOUNT's level is not the kami's
    addNodeCondition(m, 70, { type: 'LEVEL', logic: 'CURR_MAX', value: 5, for: 'ACCOUNT' }, 2);
    let d = (await serve(m, ['70'])).data as NodeFacts;
    expect(d.requirements).toHaveLength(2);
    expect(d.levelCap).toBeNull();
    addNodeCondition(m, 70, { type: 'LEVEL', logic: 'CURR_MAX', value: 40, for: 'KAMI' }, 3);
    addNodeCondition(m, 70, { type: 'LEVEL', logic: 'CURR_MAX', value: 25 }, 4); // no `for`: the kami
    d = (await serve(m, ['70'])).data as NodeFacts;
    expect(d.requirements).toHaveLength(4);
    expect(d.levelCap).toBe(25);
    // ordered by condition entity id, so two reads of one mirror agree
    const again = (await serve(m, ['70'])).data as NodeFacts;
    expect(again.requirements).toEqual(d.requirements);
    expect(valid(d)).toBe(true);
  });

  it('the five fields are LAST and ride every rung: --full, --with-vitals, the selectors', async () => {
    const m = makeMirror(7_000);
    addNode(m, 9, 'node 9', { levelLimit: 15 });
    addKami(m, { index: 601, state: 'HARVESTING', node: 9, lastTime: nowSec() - 600 });
    const tail = ['yieldItem', 'requirements', 'levelCap', 'scavengeCost', 'scavengeAffinity'];
    for (const args of [['9'], ['9', '--full'], ['9', '--with-vitals'], ['9', '--targets', '601']]) {
      const d = (await serve(m, args)).data as Record<string, unknown>;
      expect(Object.keys(d).slice(-5)).toEqual(tail);
      expect(d.levelCap).toBe(15);
      expect(valid(d)).toBe(true);
    }
  });

  it('every new string survives the envelope (classified, not pruned as authored prose)', async () => {
    const m = makeMirror(7_000);
    addNode(m, 59, undefined, { levelLimit: 35, affinity: 'EERIE' });
    const env = await serve(m, ['59']);
    const d = env.data as NodeFacts;
    expect(d.yieldItem.name).toBe('MUSU');
    expect(d.requirements[0]).toMatchObject({ logic: 'CURR_MAX', type: 'LEVEL', for: 'KAMI' });
    expect(d.scavengeAffinity).toBe('EERIE');
    expect(env.meta.suppressed).toBeUndefined();
    expect(env.untrusted.filter((p) => /yieldItem|requirements|scavenge/.test(p))).toEqual([]);
  });
});

describe('1.1.0: a node the mirror cannot project completely is refused, not served hollow', () => {
  it('yield item absent from the item registry → INCOMPLETE', async () => {
    const m = makeMirror(7_000);
    addNode(m, 52, undefined, { item: 2, itemName: null });
    await expect(serve(m, ['52'])).rejects.toMatchObject({ code: 'INCOMPLETE' });
    expect(incompleteRowsReport()).toMatchObject({ refused: 1, lastBlock: 7_000 });
  });

  it('no ItemIndex on the node → INCOMPLETE', async () => {
    const m = makeMirror(7_000);
    addNode(m, 52, undefined, { item: null });
    await expect(serve(m, ['52'])).rejects.toMatchObject({ code: 'INCOMPLETE' });
  });

  it('no scavenge registry entry → INCOMPLETE', async () => {
    const m = makeMirror(7_000);
    addNode(m, 52, undefined, { scavCost: null });
    await expect(serve(m, ['52'])).rejects.toMatchObject({ code: 'INCOMPLETE' });
  });
});
