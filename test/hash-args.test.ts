import { describe, expect, it } from 'vitest';

import { hashArgs } from 'network/shapes/utils/IDs';

import fixture from './vectors/hash-args.json';

// Gate G0: hashArgs over every argTypes signature observed at the pin,
// against vectors from an independent keccak + hand-rolled packed encoding.
describe('hashArgs known vectors (observed argTypes signatures)', () => {
  for (const v of fixture.vectors) {
    it(JSON.stringify(v.argTypes), () => {
      expect(hashArgs(v.args, v.argTypes)).toBe(v.id);
    });
  }

  it('returns the empty EntityID on invalid args (upstream behavior)', () => {
    expect(hashArgs([undefined], ['string'])).toBe('');
    expect(hashArgs(['is.config', ''], ['string', 'string'])).toBe('');
  });
});
