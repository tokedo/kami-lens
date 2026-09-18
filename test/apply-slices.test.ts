// Divergence 13 (0.6.3, L-11): the sliced apply. The properties worth
// asserting are the ones the CDN loader relies on and the ones a careless
// rewrite would quietly lose:
//
//   - every row is applied, exactly once, in array order
//   - the thread is actually HANDED BACK between slices (a macrotask runs;
//     an `await 0` would pass a microtask test and fail this one)
//   - the slice size adapts towards the budget instead of staying at its
//     starting guess
//   - applyMs excludes parked time, so the load profile's µs/row stays a
//     measure of decoding
//   - an async apply is awaited before the next slice starts (no overlap
//     within one chunk)

import { describe, expect, it } from 'vitest';

import {
  APPLY_SLICE_MAX_ROWS,
  APPLY_SLICE_MIN_ROWS,
  applyInSlices,
} from 'workers/sync/state/apply';

const rows = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('applyInSlices (divergence 13)', () => {
  it('applies every row exactly once, in order', async () => {
    const seen: number[] = [];
    const profile = await applyInSlices(rows(5_000), (slice) => void seen.push(...slice), {
      startRows: 97,
    });
    expect(seen).toEqual(rows(5_000));
    expect(profile.rows).toBe(5_000);
    expect(profile.slices).toBeGreaterThan(1);
  });

  it('does nothing at all for an empty input', async () => {
    let calls = 0;
    const profile = await applyInSlices([], () => void calls++);
    expect(calls).toBe(0);
    expect(profile).toEqual({ applyMs: 0, parkedMs: 0, slices: 0, rows: 0 });
  });

  it('yields to the MACROTASK queue between slices, not just to microtasks', async () => {
    // a setImmediate callback queued before the run must run DURING it
    let macrotaskRan = false;
    let macrotaskRanAfterFirstSlice = false;
    let slices = 0;
    const done = applyInSlices(rows(1_000), () => {
      slices++;
      if (slices === 1) setImmediate(() => (macrotaskRan = true));
      if (slices > 1 && macrotaskRan) macrotaskRanAfterFirstSlice = true;
    }, { startRows: 100 });
    await done;
    expect(macrotaskRan).toBe(true);
    expect(macrotaskRanAfterFirstSlice).toBe(true);
  });

  it('adapts the slice size towards the budget', async () => {
    const sizes: number[] = [];
    // 1 ms budget against an apply that costs ~nothing: the size must climb
    await applyInSlices(rows(400_000), (slice) => void sizes.push(slice.length), {
      startRows: APPLY_SLICE_MIN_ROWS,
      budgetMs: 1,
    });
    expect(sizes[0]).toBe(APPLY_SLICE_MIN_ROWS);
    expect(Math.max(...sizes)).toBeGreaterThan(APPLY_SLICE_MIN_ROWS);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(APPLY_SLICE_MAX_ROWS);
  });

  it('never exceeds the ceiling or drops below the floor', async () => {
    const sizes: number[] = [];
    await applyInSlices(
      rows(50_000),
      (slice) => {
        sizes.push(slice.length);
        // an apply far over budget must clamp at the floor, not below it
        const until = performance.now() + 5;
        while (performance.now() < until) {
          /* burn */
        }
      },
      { startRows: 20_000, budgetMs: 0.01 }
    );
    // the final slice is a remainder and may legitimately be smaller
    for (const s of sizes.slice(0, -1)) {
      expect(s).toBeGreaterThanOrEqual(APPLY_SLICE_MIN_ROWS);
      expect(s).toBeLessThanOrEqual(APPLY_SLICE_MAX_ROWS);
    }
  });

  it('reports applyMs without the parked time, and parkedMs separately', async () => {
    const profile = await applyInSlices(
      rows(300),
      () => {
        const until = performance.now() + 4;
        while (performance.now() < until) {
          /* burn 4 ms of real apply */
        }
      },
      // budget == the apply's own cost, so the adaptation holds the size
      // roughly where it started instead of swallowing the remainder
      { startRows: 100, budgetMs: 4 }
    );
    expect(profile.slices).toBeGreaterThanOrEqual(2);
    // ~4 ms of real work per slice; parked time is not counted in applyMs
    expect(profile.applyMs).toBeGreaterThanOrEqual(4 * profile.slices - 1);
    expect(profile.applyMs).toBeLessThan(20 * profile.slices);
    expect(profile.parkedMs).toBeGreaterThanOrEqual(0);
  });

  it('awaits an async apply before starting the next slice', async () => {
    let inFlight = 0;
    let overlapped = false;
    await applyInSlices(
      rows(1_000),
      async () => {
        inFlight++;
        if (inFlight > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
      },
      { startRows: 100 }
    );
    expect(overlapped).toBe(false);
  });

  it('reports progress as (rowsApplied, rowsTotal), monotonically', async () => {
    const seen: [number, number][] = [];
    await applyInSlices(rows(1_000), () => {}, {
      startRows: 250,
      onSlice: (applied, total) => seen.push([applied, total]),
    });
    expect(seen.at(-1)).toEqual([1_000, 1_000]);
    for (let i = 1; i < seen.length; i++) expect(seen[i]![0]).toBeGreaterThan(seen[i - 1]![0]);
  });
});
