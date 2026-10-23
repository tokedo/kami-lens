// 1.1.0 (§3.19): src/utils/fixed-point.ts reproduces the contracts' math
// libraries — Solady/Solmate expWad and lnWad on those libraries' own
// published test vectors, Solstat's Gaussian.cdf within its stated error.

import { describe, expect, it } from 'vitest';

import { WAD, cdf, expWad, gaussianShare, lnWad, powWad } from '../src/utils/fixed-point';

describe('src/utils/fixed-point', () => {
  it('expWad and lnWad: the published vectors', () => {
    const e = (x: bigint) => expWad(x).toString();
    expect(e(-3n * WAD)).toBe('49787068367863942');
    expect(e(-2n * WAD)).toBe('135335283236612691');
    expect(e(-1n * WAD)).toBe('367879441171442321');
    expect(e(-5n * 10n ** 17n)).toBe('606530659712633423');
    expect(e(-3n * 10n ** 17n)).toBe('740818220681717866');
    expect(e(0n)).toBe('1000000000000000000');
    expect(e(3n * 10n ** 17n)).toBe('1349858807576003103');
    expect(e(5n * 10n ** 17n)).toBe('1648721270700128146');
    expect(e(WAD)).toBe('2718281828459045235');
    expect(e(2n * WAD)).toBe('7389056098930650227');
    expect(e(3n * WAD)).toBe('20085536923187667741');
    expect(lnWad(WAD).toString()).toBe('0');
    expect(lnWad(2718281828459045235n).toString()).toBe('999999999999999999');
    expect(lnWad(11723640096265400935n).toString()).toBe('2461607324344817918');
    expect(() => lnWad(0n)).toThrow(/LnWadUndefined/);
  });

  it('powWad agrees with the float power to its precision', () => {
    const r = Number(powWad((WAD * 1259n) / 1000n, 10n * WAD)) / 1e18;
    expect(Math.abs(r - 1.259 ** 10)).toBeLessThan(1e-12);
  });

  it('Gaussian.cdf: 1/2 at 0, symmetric, within 1.2e-7 of the normal cdf', () => {
    expect(cdf(0n)).toBe(WAD / 2n);
    expect(Math.abs(Number(cdf(WAD)) / 1e18 - 0.8413447460685429)).toBeLessThan(1.2e-7);
    expect(Math.abs(Number(cdf(-WAD)) / 1e18 - 0.15865525393145707)).toBeLessThan(1.2e-7);
  });

  it('gaussianShare: 0 where the chain would revert (a or b is 0)', () => {
    expect(gaussianShare(0, 10, 2000, 3, 3)).toBe(0n);
    expect(gaussianShare(10, 0, 2000, 3, 3)).toBe(0n);
    // equal stats: cdf(0) = 1/2 of the ratio
    expect(gaussianShare(15, 15, 2000, 3, 3)).toBe(1000n);
  });
});
