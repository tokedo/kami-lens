import { describe, expect, it } from 'vitest';

import { unpackArray32 } from 'network/shapes/utils/packing';

import fixture from './vectors/pack-arr-u32.json';

// Gate G0: unpackArray32 must invert LibPack.packArrU32 bit-exactly. The
// packed words are computed by an independent reimplementation of the
// Solidity fold (scripts/gen-vectors.py).
describe('unpackArray32 inverts LibPack.packArrU32', () => {
  for (const v of fixture.vectors) {
    it(`${v.packed}${'note' in v ? ` (${v.note})` : ''}`, () => {
      expect(unpackArray32(BigInt(v.packed))).toEqual(v.values);
    });
  }
});
