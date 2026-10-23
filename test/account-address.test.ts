// 1.1.0 (§3.19): `inventory`, `party` and `account` take an owner ADDRESS.
//
// A reader that holds a wallet address — the one fact every agent acting for
// a player starts from — could ask `account <address>` (§3.14) but not
// `inventory <address>` or `party <address>`: the address went down the NAME
// path (inventory) or failed the index parse (party). The three now share one
// rule (build.ts accountByKey): the account whose id is uint256(uint160(owner))
// — found through its OwnerAddress — and, failing that, the account the
// address OPERATES: LibAccount.getByOwnerOrOperator's order, and the order
// `account` already used. Answers are unchanged; only the key is new.

import { beforeEach, describe, expect, it } from 'vitest';

import * as clock from 'clock';
import {
  IndexCache,
  NameCache,
  OperatorCache,
  OwnerCache,
} from 'network/shapes/Account/queries';
import { resetIncompleteRows } from '../src/projection-health';
import { serveQuery } from '../src/queries';
import { REGISTRY } from '../src/queries/registry';
import { addAccount, addKami, makeMirror, type SyntheticMirror } from './support/mirror';

// synthetic addresses: mixed case; the operator's leading zero nibble is the
// shape the mirror stores without it (formatEntityID)
const OWNER = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const OPERATOR = '0x0aBc000000000000000000000000000000000Def';
const STRANGER = '0x9999999999999999999999999999999999999999';

const serve = (m: SyntheticMirror, q: string, args: string[]) =>
  serveQuery(m, q, args, { stale: false, mode: 'daemon' });

function world(): SyntheticMirror {
  const m = makeMirror(9_000);
  const t = Math.floor(Date.now() / 1000);
  addKami(m, { index: 701, state: 'RESTING', lastTime: t - 60 });
  addKami(m, { index: 702, state: 'RESTING', lastTime: t - 60 });
  addAccount(m, 12, [701, 702], { owner: OWNER, operator: OPERATOR });
  return m;
}

beforeEach(() => {
  clock.reset();
  resetIncompleteRows();
  // the account lookups cache entity indices per key, module-wide; every
  // test builds its own mirror
  for (const c of [IndexCache, NameCache, OperatorCache, OwnerCache]) c.clear();
});

describe('1.1.0: inventory, party and account by owner address', () => {
  for (const q of ['inventory', 'party', 'account'] as const) {
    it(`${q} <owner address> answers exactly what ${q} <index> answers`, async () => {
      const m = world();
      const byIndex = (await serve(m, q, ['12'])).data;
      const byAddress = (await serve(m, q, [OWNER])).data;
      expect(byAddress).toEqual(byIndex);
      expect((byAddress as { account?: { index: number }; index?: number }).account?.index ??
        (byAddress as { index: number }).index).toBe(12);
    });

    it(`${q}: the address is case-insensitive`, async () => {
      const m = world();
      const lower = (await serve(m, q, [OWNER.toLowerCase()])).data;
      const upper = (await serve(m, q, ['0x' + OWNER.slice(2).toUpperCase()])).data;
      expect(upper).toEqual(lower);
      expect(lower).toEqual((await serve(m, q, ['12'])).data);
    });

    it(`${q}: an address that owns and operates no account is NOT_FOUND, naming the address`, async () => {
      const m = world();
      await expect(serve(m, q, [STRANGER])).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: `account ${STRANGER} not in mirror`,
      });
    });

    it(`${q}: an OPERATOR address resolves to the account it operates (owner first)`, async () => {
      const m = world();
      const byOperator = (await serve(m, q, [OPERATOR])).data;
      expect(byOperator).toEqual((await serve(m, q, ['12'])).data);
    });
  }

  it('parses an address as an address, an index as an index, a short 0x string as a name', () => {
    expect(REGISTRY.inventory.parseArgs([OWNER])).toEqual({ address: OWNER });
    expect(REGISTRY.inventory.parseArgs(['12'])).toEqual({ index: 12 });
    expect(REGISTRY.inventory.parseArgs(['0xdeadbeef'])).toEqual({ name: '0xdeadbeef' });
    expect(REGISTRY.party.parseArgs([OWNER, '--full'])).toEqual({
      address: OWNER,
      full: true,
      stats: false,
    });
    expect(REGISTRY.party.parseArgs(['12'])).toMatchObject({ accountIndex: 12 });
    // party still takes no NAME — a non-address, non-integer key stays BAD_ARGS
    expect(() => REGISTRY.party.parseArgs(['alice'])).toThrow(/account index/);
  });

  it('the summaries say so', () => {
    for (const q of ['account', 'inventory', 'party'] as const) {
      expect(REGISTRY[q].summary).toMatch(/owner address/);
    }
  });
});
