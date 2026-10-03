// 1.0.0 (B3): `kami --equipment` serves what the kami has equipped, slot by
// slot, from the reference client's own getters (app/cache/equipment), which
// were ported and unused. Slot names are verbatim — they are the game's keys.

import Ajv from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import { genEquipmentID } from 'app/cache/equipment/equipment';
import { setComponent } from 'engine/recs';
import { hashArgs } from 'network/shapes/utils';
import { loadSchema, serveQuery } from '../src/queries';
import { REGISTRY } from '../src/queries/registry';
import { addKami, makeMirror, type SyntheticMirror } from './support/mirror';

const ajv = new Ajv({ strict: true, allErrors: true });
ajv.addSchema(loadSchema('kami' as never), 'kami');
const serve = (m: SyntheticMirror, args: string[]) =>
  serveQuery(m, 'kami', args, { stale: false, mode: 'daemon' });

function addItem(m: SyntheticMirror, index: number, name: string) {
  const e = m.world.registerEntity({
    id: hashArgs(['registry.item', index], ['string', 'uint32']),
  });
  setComponent(m.components.EntityType, e, { value: 'ITEM' });
  setComponent(m.components.ItemIndex, e, { value: index });
  setComponent(m.components.Name, e, { value: name });
  setComponent(m.components.Type, e, { value: 'EQUIPMENT' });
}

function equip(m: SyntheticMirror, kamiIndex: number, slot: string, itemIndex: number) {
  const kamiId = hashArgs(['kami.id', kamiIndex], ['string', 'uint32']);
  const kami = m.world.entities[m.world.entityToIndex.get(kamiId)!]!;
  const e = m.world.registerEntity({ id: genEquipmentID(kami, slot) });
  setComponent(m.components.OwnsEquipID, e, { value: kami });
  setComponent(m.components.ItemIndex, e, { value: itemIndex });
}

describe('kami --equipment (B3)', () => {
  it('serves capacity and every slot, occupied or null, names verbatim', async () => {
    const m = makeMirror(3_000);
    addKami(m, {
      index: 41,
      state: 'RESTING',
      lastTime: Math.floor(Date.now() / 1000) - 60,
    });
    addItem(m, 30001, 'Iron Helm');
    equip(m, 41, 'Head_Slot', 30001);
    const env = await serve(m, ['41', '--equipment']);
    const eq = (env.data as { equipment: { capacity: number; slots: unknown[] } }).equipment;
    expect(eq.capacity).toBe(1);
    expect(eq.slots).toEqual([
      { slot: 'Head_Slot', item: { index: 30001, name: 'Iron Helm' } },
      { slot: 'Body_Slot', item: null },
      { slot: 'Hands_Slot', item: null },
      { slot: 'Passport_slot', item: null },
      { slot: 'Kami_Pet_Slot', item: null },
    ]);
    expect(ajv.validate('kami', env.data)).toBe(true);
  });

  it("an equipment row owned by ANOTHER kami is not this kami's", async () => {
    const m = makeMirror(3_000);
    const t = Math.floor(Date.now() / 1000) - 60;
    addKami(m, { index: 41, state: 'RESTING', lastTime: t });
    addKami(m, { index: 42, state: 'RESTING', lastTime: t });
    addItem(m, 30001, 'Iron Helm');
    // 41's slot id, but recorded as owned by 42 (the getter's own check)
    const id41 =
      m.world.entities[
        m.world.entityToIndex.get(hashArgs(['kami.id', 41], ['string', 'uint32']))!
      ]!;
    const id42 =
      m.world.entities[
        m.world.entityToIndex.get(hashArgs(['kami.id', 42], ['string', 'uint32']))!
      ]!;
    const e = m.world.registerEntity({ id: genEquipmentID(id41, 'Head_Slot') });
    setComponent(m.components.OwnsEquipID, e, { value: id42 });
    setComponent(m.components.ItemIndex, e, { value: 30001 });
    const eq = (
      (await serve(m, ['41', '--equipment'])).data as {
        equipment: { slots: { item: unknown }[] };
      }
    ).equipment;
    expect(eq.slots.every((s) => s.item === null)).toBe(true);
  });

  it('flag-off: no equipment key', async () => {
    const m = makeMirror(3_000);
    addKami(m, {
      index: 41,
      state: 'RESTING',
      lastTime: Math.floor(Date.now() / 1000) - 60,
    });
    const data = (await serve(m, ['41'])).data as Record<string, unknown>;
    expect('equipment' in data).toBe(false);
  });

  it('parses beside --stats in any order', () => {
    expect(REGISTRY.kami.parseArgs(['--equipment', '41', '--stats'])).toEqual({
      index: 41,
      stats: true,
      equipment: true,
    });
  });
});
