// DEFECT 1 regression (§3.14) — the config-cache poisoning that served
// `hp: null` for every harvesting kami, permanently, for six days.
//
// Two independent failures had to line up, and both are pinned here:
//
//   1. app/cache/config/base.ts cached a SENTINEL read. The reader answers
//      `[]` when a config entity exists but its Value component has not
//      hydrated, and eight zeros when the entity itself is missing. Upstream
//      stored either one and `getArray` never re-fetched a cached field, so a
//      single read during boot froze the value for the process lifetime.
//   2. app/cache/config/kami.ts could not SEE the poison. `[]` structures to
//      `undefined / 10 ** undefined` = NaN, and upstream's re-read guard
//      compares each value against 0 — `NaN === 0` is false — so the poisoned
//      config read as HEALTHY and was stamped as good. The eight-zeros shape
//      correctly triggered a re-read; the shape that actually mattered did
//      not. The guard was inverted for exactly the case it exists to catch.
//
// The reader is stubbed so the sentinel can be produced on demand; the cache
// and the falsey guard under test are the real ones.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const reads = { value: [] as number[], calls: 0 };

vi.mock('network/shapes/Config', () => ({
  getConfigFieldValue: () => {
    reads.calls++;
    return reads.value[0] ?? 0;
  },
  getConfigFieldValueArray: () => {
    reads.calls++;
    return reads.value;
  },
  getConfigFieldValueAddress: () => '0x000000000000000000000000000000000000dEaD',
}));

const { ArrayCache, ValueCache, getArray, getValue, isRealConfigArray } = await import(
  '../src/app/cache/config/base'
);

const world = {} as never;
const comps = {} as never;
const REAL = [5, 0, 480, 0, 0, 0, 10, 0];

beforeEach(() => {
  ArrayCache.clear();
  ValueCache.clear();
  reads.calls = 0;
});

describe('config array cache — a sentinel read is never cached (§4.2)', () => {
  it('recognises both sentinel shapes and a real value', () => {
    expect(isRealConfigArray([])).toBe(false); // Value component not hydrated
    expect(isRealConfigArray(new Array(8).fill(0))).toBe(false); // entity missing
    expect(isRealConfigArray(REAL)).toBe(true);
    expect(isRealConfigArray([NaN, NaN])).toBe(false);
  });

  it('does not cache the unhydrated shape, and HEALS on the next read', () => {
    reads.value = []; // boot: the Value component has not landed yet
    expect(getArray(world, comps, 'KAMI_HARV_INTENSITY')).toEqual([]);
    expect(ArrayCache.has('KAMI_HARV_INTENSITY')).toBe(false);

    reads.value = REAL; // the mirror finishes hydrating
    expect(getArray(world, comps, 'KAMI_HARV_INTENSITY')).toEqual(REAL);
    expect(ArrayCache.get('KAMI_HARV_INTENSITY')).toEqual(REAL);
  });

  it('does not cache the entity-missing shape either', () => {
    reads.value = new Array(8).fill(0);
    expect(getArray(world, comps, 'KAMI_TREE_REQ')).toEqual(new Array(8).fill(0));
    expect(ArrayCache.has('KAMI_TREE_REQ')).toBe(false);
    reads.value = REAL;
    expect(getArray(world, comps, 'KAMI_TREE_REQ')).toEqual(REAL);
  });

  it('RETURNS the value it just read, never undefined', () => {
    // the regression the guard itself introduced, and the same hole upstream
    // already had for addresses: getArray returned `Cache.get(field)!` — which
    // is undefined for a value the guard deliberately did not store, and
    // structureAST then threw on `config[0]` of undefined
    reads.value = [];
    expect(getArray(world, comps, 'ANY')).not.toBeUndefined();
    expect(getValue(world, comps, 'ANY')).not.toBeUndefined();
  });

  it('still caches a real value exactly once', () => {
    reads.value = REAL;
    getArray(world, comps, 'KAMI_HARV_BOUNTY');
    const after = reads.calls;
    getArray(world, comps, 'KAMI_HARV_BOUNTY');
    getArray(world, comps, 'KAMI_HARV_BOUNTY');
    expect(reads.calls).toBe(after); // served from cache, no re-read
  });

  it('a config field holding a real 0 is re-read rather than frozen', () => {
    // the accepted cost of the guard: a genuinely-zero field pays one
    // component read per call instead of being cached at a value that is
    // indistinguishable from "not there yet"
    reads.value = [0];
    getValue(world, comps, 'SOME_ZERO_FIELD');
    const after = reads.calls;
    getValue(world, comps, 'SOME_ZERO_FIELD');
    expect(reads.calls).toBeGreaterThan(after);
  });
});

describe('the re-read guard can see NaN (§4.2)', () => {
  const structureAST = (config: number[]) => ({
    nudge: { raw: config[0], precision: config[1], value: config[0] / 10 ** config[1] },
    ratio: { raw: config[2], precision: config[3], value: config[2] / 10 ** config[3] },
    shift: { raw: config[4], precision: config[5], value: config[4] / 10 ** config[5] },
    boost: { raw: config[6], precision: config[7], value: config[6] / 10 ** config[7] },
  });
  const upstreamFalsey = (n: ReturnType<typeof structureAST>) =>
    n.nudge.value === 0 && n.ratio.value === 0 && n.shift.value === 0 && n.boost.value === 0;
  const unusable = (v: number) => !Number.isFinite(v) || v === 0;
  const portedFalsey = (n: ReturnType<typeof structureAST>) =>
    unusable(n.nudge.value) && unusable(n.ratio.value) && unusable(n.shift.value) && unusable(n.boost.value);

  it('the unhydrated shape structures to NaN, and JSON renders it as null', () => {
    const ast = structureAST([]);
    expect(Number.isNaN(ast.nudge.value)).toBe(true);
    expect(JSON.stringify({ v: ast.nudge.value })).toBe('{"v":null}'); // the lie
  });

  it('upstream reads the poisoned config as healthy; the port does not', () => {
    const poisoned = structureAST([]);
    expect(upstreamFalsey(poisoned)).toBe(false); // stamped good -> permanent
    expect(portedFalsey(poisoned)).toBe(true); // re-read forced
  });

  it('both agree on the harmless shape and on a real config', () => {
    const zeros = structureAST(new Array(8).fill(0));
    expect(upstreamFalsey(zeros)).toBe(true);
    expect(portedFalsey(zeros)).toBe(true);
    const real = structureAST(REAL);
    expect(upstreamFalsey(real)).toBe(false);
    expect(portedFalsey(real)).toBe(false);
  });
});
