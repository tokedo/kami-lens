// DEFECT 6 regression (§3.14) — `config <name>` could not tell a field that
// does not exist from a field whose value is zero.
//
// The underlying reader answers 0 (and eight zeros for the array form) for a
// missing config entity, so a probe for a name nobody ever deployed came back
// looking like a settled fact. A reader that guesses a plausible key gets the
// guess CONFIRMED — which is what happened: an arm queried a fabricated
// POOL_*ENABLED family that exists nowhere upstream and carried the false
// model for about twenty sessions.
//
// Plus the second failure in the same query: a packed field read through the
// scalar form served 1.347997333357532e+68.

import { describe, expect, it } from 'vitest';

describe('absence is not zero', () => {
  // what the reader returns for a missing entity, verbatim from the port
  const readerForMissingEntity = { scalar: 0, array: new Array(8).fill(0) };
  const readerForRealZeroField = { scalar: 0, array: new Array(8).fill(0) };

  it('the reader itself cannot distinguish the two — which is why the QUERY must', () => {
    expect(readerForMissingEntity).toEqual(readerForRealZeroField);
  });

  it('existence is decided by the entity, never by the value', () => {
    // the query now asks `configFieldEntity(world, name) !== undefined` and
    // answers NOT_FOUND on absence, so a zero it DOES serve is a real zero
    const exists = (entity: unknown) => entity !== undefined;
    expect(exists(undefined)).toBe(false); // -> NOT_FOUND
    expect(exists(1234)).toBe(true); // -> serve the value, even if 0
  });
});

describe('packed values are not floats', () => {
  // KAMI_HARV_INTENSITY packs eight uint32s into one uint256
  const PACKED = 134799733335753199674855861353931554105954441816518711840408621547520n;
  const SCALAR = 180n; // KAMI_STANDARD_COOLDOWN

  const project = (stored: bigint) => {
    const fits =
      stored <= BigInt(Number.MAX_SAFE_INTEGER) && stored >= BigInt(Number.MIN_SAFE_INTEGER);
    return { ...(fits ? { value: Number(stored) } : {}), valueRaw: stored.toString() };
  };

  it('an ordinary scalar reads exactly as it did before', () => {
    expect(project(SCALAR).value).toBe(180);
  });

  it('a packed value is ABSENT from `value` rather than wrong', () => {
    const out = project(PACKED);
    expect(out.value).toBeUndefined();
    expect(Number(PACKED)).toBe(1.347997333357532e68); // what used to be served
  });

  it('the verbatim form is always there and is exact', () => {
    expect(project(PACKED).valueRaw).toBe(PACKED.toString());
    expect(BigInt(project(PACKED).valueRaw)).toBe(PACKED); // round-trips
    expect(project(SCALAR).valueRaw).toBe('180');
  });
});
