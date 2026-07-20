import { describe, expect, it } from 'vitest';

import { createDecode, createDecoder } from 'engine/encoders';
import { ContractSchemaValue } from 'engine/encoders/types';
import { ComponentsSchema } from 'types/ComponentsSchema';

import fixture from './vectors/decode.json';

// Gate G0: the component-value decode tables, driven by vectors whose ABI
// encoding is hand-rolled in scripts/gen-vectors.py (independent of ethers).
// The seven valueTypes covered are exactly the set ComponentsSchema uses at
// the pin: BOOL, INT32, UINT32, UINT256, STRING, UINT32_ARRAY, UINT256_ARRAY.
describe('createDecoder known vectors', () => {
  for (const v of fixture.vectors) {
    it(v.name, () => {
      const decoder = createDecoder(['value'], v.valueTypes);
      expect(decoder(v.data)).toEqual(v.expected);
    });
  }

  it('fixture covers every valueType present in ComponentsSchema at the pin', () => {
    const present = new Set(
      Object.values(ComponentsSchema).flatMap((schema) => schema.values)
    );
    const covered = new Set(fixture.vectors.flatMap((v) => v.valueTypes));
    expect([...present].sort((a, b) => a - b)).toEqual([...covered].sort((a, b) => a - b));
  });
});

describe('createDecode resolves schemas from ComponentsSchema', () => {
  // first table entry at the pin — a uint256 'value' schema
  const uint256ComponentID = '0x8a1264e7094de803414cccf0c32d2bd50f25c909fa2415b38f065f320e4eabe6';
  // hardcoded upstream: world.component.components uses the uint256 schema
  const componentsKey = '0x4350dba81aa91e31664a09d24a668f006169a11b3d962b7557aed362d3252aec';
  const uint256Vector = fixture.vectors.find(
    (v) => v.valueTypes[0] === ContractSchemaValue.UINT256
  )!;

  it('decodes a registry component via its schema table entry', async () => {
    expect(ComponentsSchema[uint256ComponentID]).toEqual({ keys: ['value'], values: [13] });
    const decode = createDecode();
    expect(await decode(uint256ComponentID, uint256Vector.data)).toEqual(uint256Vector.expected);
  });

  it('decodes the hardcoded world.component.components key', async () => {
    const decode = createDecode();
    expect(await decode(componentsKey, uint256Vector.data)).toEqual(uint256Vector.expected);
  });

  it('falls back to the bool schema for unknown components (upstream behavior)', async () => {
    const decode = createDecode();
    const boolVector = fixture.vectors.find((v) => v.valueTypes[0] === ContractSchemaValue.BOOL)!;
    expect(await decode('0x' + 'ab'.repeat(32), boolVector.data)).toEqual(boolVector.expected);
  });
});
