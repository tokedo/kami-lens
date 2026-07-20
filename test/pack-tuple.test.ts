import { describe, expect, it } from 'vitest';

import { packTuple, unpackTuple } from '@mud-classic/utils';

import fixture from './vectors/pack-tuple.json';

// Gate G0: tuple packing round-trips, and matches vectors computed by an
// independent reimplementation of the JS signed-32-bit semantics.
describe('packTuple/unpackTuple', () => {
  for (const v of fixture.vectors) {
    const tuple = v.tuple as [number, number];
    it(`[${v.tuple}] ⇄ ${v.packed}`, () => {
      expect(packTuple(tuple)).toBe(v.packed);
      expect(unpackTuple(v.packed)).toEqual(tuple);
    });
  }

  it('round-trips across the componentIdx/entityIdx range', () => {
    for (const componentIdx of [0, 1, 63, 94, 128, 255]) {
      for (const entityIdx of [0, 1, 65535, 16777215]) {
        expect(unpackTuple(packTuple([componentIdx, entityIdx]))).toEqual([
          componentIdx,
          entityIdx,
        ]);
      }
    }
  });

  it('rejects out-of-range values (upstream behavior)', () => {
    expect(() => packTuple([256, 0])).toThrow('Overflow');
    expect(() => packTuple([0, 16777216])).toThrow('Overflow');
    expect(() => packTuple([-1, 0])).toThrow('Underflow');
  });
});
