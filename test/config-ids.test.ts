import { describe, expect, it } from 'vitest';

import { formatEntityID } from 'engine/utils';
import { hashArgs } from 'network/shapes/utils/IDs';

import fixture from './vectors/config-ids.json';

// Gate G0: hashArgs(['is.config', <field>], ['string', 'string']) must
// reproduce LibConfig.genID (contracts) for every checked-in vector. Vectors
// come from an independent keccak implementation (scripts/gen-vectors.py).
describe('hashArgs reproduces LibConfig.genID', () => {
  for (const v of fixture.vectors) {
    it(v.field, () => {
      expect(hashArgs(['is.config', v.field], ['string', 'string'])).toBe(v.id);
      // the unpadded id is exactly formatEntityID of the raw 32-byte hash
      expect(formatEntityID(v.hash)).toBe(v.id);
    });
  }

  it('covers the unpadded-id case (hash with a leading zero nibble)', () => {
    expect(fixture.vectors.some((v) => v.id.length < v.hash.length)).toBe(true);
  });
});
