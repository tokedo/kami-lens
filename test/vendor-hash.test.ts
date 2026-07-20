import { id } from 'ethers';
import { describe, expect, it } from 'vitest';

import { keccak256 } from '@mud-classic/utils';
import { formatComponentID } from 'engine/utils';

// The vendored keccak256 re-expresses the artifact's ethers-v5 body
// (BigNumber.from(keccak256(toUtf8Bytes(data))).toHexString()) in v6 terms.
// v5 toHexString() yields minimal byte-aligned hex — exactly
// formatComponentID's output shape — so the two must agree everywhere.
describe('vendored @mud-classic/utils keccak256 (v5→v6 equivalence)', () => {
  const cases = [
    'component.LoadingState',
    'world.component.components',
    'world.component.systems',
    'component.name',
    'component.index.room',
    // hunt coverage for leading-zero-nibble and leading-zero-byte hashes
    ...Array.from({ length: 64 }, (_, i) => `kami-lens.probe.${i}`),
  ];

  for (const data of cases) {
    it(data, () => {
      expect(keccak256(data)).toBe(formatComponentID(id(data)));
    });
  }

  it('pads odd-length hex to whole bytes', () => {
    const oddCase = cases.find((c) => BigInt(id(c)).toString(16).length % 2 === 1);
    expect(oddCase).toBeDefined();
    expect(keccak256(oddCase!).length % 2).toBe(0);
  });
});
