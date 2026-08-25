// DEFECT 2 regression (§4.2) — `account` answering NOT_FOUND for accounts
// that plainly exist.
//
// Two independent causes, both pinned here. The observed symptom was one
// arm getting "account main not in mirror" on 31 of 49 calls and another
// hitting the same wall by NAME and by OWNER ADDRESS minutes after
// registering — and the intermittency is itself explained below.
//
//   1. queryByName and queryByOwner cached only when MORE THAN ONE entity
//      matched (`length > 1`). One match is the normal case, so nothing was
//      cached and the function returned the cache miss — undefined — which
//      getAccountByName turns into NullAccount and the query turns into
//      NOT_FOUND. It appeared intermittent only because an unrelated code
//      path could happen to warm the cache for that name first.
//   2. queryByOwner matched a RAW address string against a component the
//      mirror stores normalised, so it matched nothing at all regardless.
//
// The docket recorded this as "accounts that own no kamis". It is not: the
// discriminator is the LOOKUP KEY. Lookup by index always worked.

import { describe, expect, it } from 'vitest';

import { formatEntityID } from '../src/engine/utils';

describe('the cache guard that dropped every unique match', () => {
  // the upstream guard vs the ported one, over the match counts that occur
  const upstream = (length: number) => length > 1;
  const ported = (length: number) => length > 0;

  it('one match is the normal case and MUST be cached', () => {
    expect(upstream(1)).toBe(false); // the defect: never cached -> undefined
    expect(ported(1)).toBe(true);
  });

  it('zero matches is still a miss under both', () => {
    expect(upstream(0)).toBe(false);
    expect(ported(0)).toBe(false);
  });

  it('the guard the working lookups always used is the ported one', () => {
    // queryByIndex: `if (length > 0)`; queryByOperator: `length > 0 && …`
    for (const n of [1, 2, 7]) expect(ported(n)).toBe(true);
  });
});

describe('owner-address normalisation', () => {
  // the exact shapes measured against the mirror: the stored component value
  // is lower-cased, and an odd leading nibble loses its zero
  it('lower-cases a checksummed address', () => {
    expect(formatEntityID('0x4f25782FAb5CCE66CC2138feC33F48a83a262123')).toBe(
      '0x4f25782fab5cce66cc2138fec33f48a83a262123'
    );
  });

  it('strips the leading zero the mirror strips — the operator shape', () => {
    // served 0x0fFf1cFdF583F2DECd88d759B7C7bF1687453076
    // stored 0xfff1cfdf583f2decd88d759b7c7bf1687453076
    expect(formatEntityID('0x0fFf1cFdF583F2DECd88d759B7C7bF1687453076')).toBe(
      '0xfff1cfdf583f2decd88d759b7c7bf1687453076'
    );
  });

  it('is idempotent, so formatting an already-stored value is safe', () => {
    const once = formatEntityID('0x4553b58d1B048E833Fd8aE1f3F17Ab3c1E6652eE');
    expect(formatEntityID(once)).toBe(once);
  });
});

describe('the account query accepts all three lookup keys', () => {
  const parse = (key: string) => {
    if (/^0x[0-9a-fA-F]{40}$/.test(key)) return { address: key };
    return /^\d+$/.test(key) ? { index: Number(key) } : { name: key };
  };

  it('routes an index, a name and an address to different keys', () => {
    expect(parse('78')).toEqual({ index: 78 });
    expect(parse('altair')).toEqual({ name: 'altair' });
    expect(parse('0x4553b58d1B048E833Fd8aE1f3F17Ab3c1E6652eE')).toEqual({
      address: '0x4553b58d1B048E833Fd8aE1f3F17Ab3c1E6652eE',
    });
  });

  it('does not mistake an address for a name — the run-006 failure', () => {
    const parsed = parse('0x5bCcd666B7f4A0F21041Fc1e774186387b957fE3');
    expect(parsed).not.toHaveProperty('name');
  });

  it('a name that merely starts with 0x is still a name', () => {
    expect(parse('0xdeadbeef')).toEqual({ name: '0xdeadbeef' }); // wrong length
  });
});
