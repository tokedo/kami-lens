// 1.0.2 (B3): an inventory row for an item the registry does not hold says
// which item it is.
//
// The ported Inventory shape resolves a row's item through the registry
// (IsRegistry + ItemIndex); an inventory instance whose stored ItemIndex has
// no registry entry resolves to upstream's NullItem — `{id: "0", index: 0,
// name: "None"}` — and was served that way, with its balance, so a reader
// could not tell which item it held nor compare the balance with the chain.
// Live accounts hold such instances. The QUERY layer now serves the
// instance's own stored index on such a row, with `unregistered: true`; the
// ported shapes stay verbatim, and a row whose stored index is itself absent
// stays as it was.

import Ajv from 'ajv/dist/2020';
import { beforeEach, describe, expect, it } from 'vitest';

import * as clock from 'clock';
import { setComponent } from 'engine/recs';
import { hashArgs } from 'network/shapes/utils';
import { loadSchema, serveQuery } from '../src/queries';
import { addAccount, makeMirror, type SyntheticMirror } from './support/mirror';

const ajv = new Ajv({ strict: true, allErrors: true });
ajv.addSchema(loadSchema('inventory'), 'inventory');

const ACCOUNT = 7;
const GHOST_GUM = 11;
const UNREGISTERED = 9_999;

function addItem(m: SyntheticMirror, index: number, name: string) {
  const e = m.world.registerEntity({ id: hashArgs(['registry.item', index], ['string', 'uint32']) });
  setComponent(m.components.EntityType, e, { value: 'ITEM' });
  setComponent(m.components.ItemIndex, e, { value: index });
  setComponent(m.components.Name, e, { value: name });
  setComponent(m.components.Type, e, { value: 'FOOD' });
  setComponent(m.components.IsRegistry, e, { value: true });
}

/** an inventory instance as the world stores it; `itemIndex: undefined`
 * models an instance whose ItemIndex component the mirror does not hold */
function addInventory(
  m: SyntheticMirror,
  holderId: string,
  itemIndex: number | undefined,
  balance: number,
  salt = 0
) {
  const id = hashArgs(
    ['inventory.instance', holderId, itemIndex ?? salt],
    ['string', 'uint256', 'uint32']
  );
  const e = m.world.registerEntity({ id });
  setComponent(m.components.EntityType, e, { value: 'INVENTORY' });
  setComponent(m.components.OwnsInvID, e, { value: holderId });
  if (itemIndex !== undefined) setComponent(m.components.ItemIndex, e, { value: itemIndex });
  setComponent(m.components.Value, e, { value: balance });
}

function world() {
  const m = makeMirror(9_000);
  addAccount(m, ACCOUNT, []);
  const holder = hashArgs(['account', ACCOUNT], ['string', 'uint32']);
  addItem(m, GHOST_GUM, 'Maple-Flavor Ghost Gum');
  addInventory(m, holder, GHOST_GUM, 5);
  addInventory(m, holder, UNREGISTERED, 3); // no registry entry for 9999
  addInventory(m, holder, undefined, 2, 424_242); // no stored index at all
  return m;
}

type Row = { balance: number; item: Record<string, unknown>; unregistered?: boolean };

beforeEach(() => clock.reset());

describe('1.0.2 (B3): an unregistered inventory item says which item it is', () => {
  it('serves the stored item index and unregistered: true; registered rows are unchanged', async () => {
    const env = await serveQuery(world(), 'inventory', [String(ACCOUNT)], {
      stale: false,
      mode: 'daemon',
    });
    const rows = (env.data as { items: Row[] }).items;
    expect(ajv.validate('inventory', env.data), ajv.errorsText(ajv.errors)).toBe(true);

    const unregistered = rows.find((r) => r.balance === 3)!;
    expect(unregistered).toEqual({
      balance: 3,
      item: { id: '0', index: UNREGISTERED, name: 'None', type: '', rarity: 0 },
      unregistered: true,
    });

    const gum = rows.find((r) => r.balance === 5)!;
    expect(gum.item.index).toBe(GHOST_GUM);
    expect(gum.item.name).toBe('Maple-Flavor Ghost Gum');
    expect('unregistered' in gum).toBe(false);
 
    // ascending item index (SPEC §1.1) holds for the index now served — the
    // reference client's prep had sorted the null item first, as index 0
    expect(rows.map((r) => r.item.index)).toEqual([0, GHOST_GUM, UNREGISTERED]);
  });

  it('a row whose stored index is itself absent stays as it was', async () => {
    const env = await serveQuery(world(), 'inventory', [String(ACCOUNT)], {
      stale: false,
      mode: 'daemon',
    });
    const rows = (env.data as { items: Row[] }).items;
    const unknown = rows.find((r) => r.balance === 2)!;
    expect(unknown).toEqual({
      balance: 2,
      item: { id: '0', index: 0, name: 'None', type: '', rarity: 0 },
    });
  });
});
