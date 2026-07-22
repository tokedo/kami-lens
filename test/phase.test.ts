// World-phase vectors (0.2.0): the ported getPhaseOf/getPhaseName
// (utils/time.ts — the 36-hour cycle, 12-hour phases, Unix-epoch anchor)
// against hand-computed fixtures, including every boundary. getCurrPhase
// is getPhaseOf(clock.now()) and is exercised by gate G6 instead — vectors
// here stay time-independent.

import { describe, expect, it } from 'vitest';

import { getPhaseName, getPhaseOf } from '../src/utils/time';

const HOUR_MS = 3_600_000;

describe('getPhaseOf', () => {
  it('maps the 36-hour cycle to phases 1/2/3 at every boundary', () => {
    // phase 1 DAYLIGHT: hours 0–11
    expect(getPhaseOf(0)).toBe(1);
    expect(getPhaseOf(11 * HOUR_MS + HOUR_MS - 1)).toBe(1);
    // phase 2 EVENFALL: hours 12–23
    expect(getPhaseOf(12 * HOUR_MS)).toBe(2);
    expect(getPhaseOf(23 * HOUR_MS + HOUR_MS - 1)).toBe(2);
    // phase 3 MOONSIDE: hours 24–35
    expect(getPhaseOf(24 * HOUR_MS)).toBe(3);
    expect(getPhaseOf(35 * HOUR_MS + HOUR_MS - 1)).toBe(3);
    // wrap: hour 36 == hour 0
    expect(getPhaseOf(36 * HOUR_MS)).toBe(1);
    expect(getPhaseOf(72 * HOUR_MS)).toBe(1);
  });

  it('honors the precision parameter (default 3 = ms in)', () => {
    // raw seconds with precision 0 equal the ms default
    expect(getPhaseOf(12 * 3600, 0)).toBe(2);
    expect(getPhaseOf(12 * HOUR_MS)).toBe(getPhaseOf(12 * 3600, 0));
  });

  it('reproduces a dated absolute vector', () => {
    // 2026-07-22T17:46:32Z ≈ 1784742392000 ms → epoch-hour 495761,
    // 495761 mod 36 = 5 → cycle-hour 5 → phase 1 (DAYLIGHT)
    expect(getPhaseOf(1_784_742_392_000)).toBe(1);
    // + 7 hours crosses the hour-12 boundary → EVENFALL
    expect(getPhaseOf(1_784_742_392_000 + 7 * HOUR_MS)).toBe(2);
  });
});

describe('getPhaseName', () => {
  it('names the three phases and answers empty outside them', () => {
    expect(getPhaseName(1)).toBe('DAYLIGHT');
    expect(getPhaseName(2)).toBe('EVENFALL');
    expect(getPhaseName(3)).toBe('MOONSIDE');
    expect(getPhaseName(0)).toBe('');
    expect(getPhaseName(4)).toBe('');
  });
});
