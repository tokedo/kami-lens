// kami-lens native module (not a port): the contracts' own fixed-point math,
// for the served values that must equal the chain's integer arithmetic
// (1.1.0, DESIGN §3.19). Transcribed step for step to BigInt from the
// libraries the contracts call at the pinned upstream commit:
//
//   - lnWad / expWad / powWad — Solady FixedPointMathLib (MIT; the version the
//     contracts lock, Vectorized/solady 73f13dd1). The contracts' Solmate copy
//     (packages/contracts/src/utils/FixedPointMathLib.sol, AGPL-3.0-only)
//     computes the same values and differs only in where expWad returns 0 for
//     very negative input; `expWad(x, 'solmate')` takes that cut.
//   - erfc / cdf — Solstat Gaussian with its Units helpers
//     (packages/contracts/src/utils/Gaussian.sol, Units.sol; AGPL-3.0-only).
//
// Signed division truncates toward zero (EVM sdiv), `>>` on a signed value is
// arithmetic (EVM sar), and an unchecked product is wrapped to 256 bits, so
// a result equals the contract's to the last unit. test/fixed-point.test.ts
// holds these to the libraries' own published test vectors.

export const WAD = 10n ** 18n;

const i256 = (x: bigint): bigint => BigInt.asIntN(256, x);
const u256 = (x: bigint): bigint => BigInt.asUintN(256, x);

/** floor(log2(x)) for x > 0 */
function msb(x: bigint): bigint {
  if (x <= 0n) throw new Error('msb of a non-positive');
  return BigInt(x.toString(2).length - 1);
}

/** exp(x) in WAD (Remco Bloemen's rational approximation, as Solady) */
export function expWad(xIn: bigint, variant: 'solady' | 'solmate' = 'solady'): bigint {
  let x = xIn;
  const lowCut = variant === 'solady' ? -41446531673892822313n : -42139678854452767551n;
  if (x <= lowCut) return 0n;
  if (x >= 135305999368893231589n) throw new Error('ExpOverflow');
  x = i256(x << 78n) / 5n ** 18n;
  const k = (i256(x << 96n) / 54916777467707473351141471128n + 2n ** 95n) >> 96n;
  x = x - k * 54916777467707473351141471128n;
  let y = x + 1346386616545796478920950773328n;
  y = (i256(y * x) >> 96n) + 57155421227552351082224309758442n;
  let p = y + x - 94201549194550492254356042504812n;
  p = (i256(p * y) >> 96n) + 28719021644029726153956944680412240n;
  p = i256(p * x + (4385272521454847904659076985693276n << 96n));
  let q = x - 2855989394907223263936484059900n;
  q = (i256(q * x) >> 96n) + 50020603652535783019961831881945n;
  q = (i256(q * x) >> 96n) - 533845033583426703283633433725380n;
  q = (i256(q * x) >> 96n) + 3604857256930695427073651918091429n;
  q = (i256(q * x) >> 96n) - 14423608567350463180887372962807573n;
  q = (i256(q * x) >> 96n) + 26449188498355588339934803723976023n;
  const r = p / q;
  return (u256(r) * 3822833074963236453042738258902158003155416615667n) >> (195n - k);
}

/** ln(x) in WAD, x > 0 (as Solady) */
export function lnWad(xIn: bigint): bigint {
  if (xIn <= 0n) throw new Error('LnWadUndefined');
  const k = msb(xIn) - 96n;
  const x = u256(xIn << (159n - k)) >> 159n;
  let p = x + 3273285459638523848632254066296n;
  p = (i256(p * x) >> 96n) + 24828157081833163892658089445524n;
  p = (i256(p * x) >> 96n) + 43456485725739037958740375743393n;
  p = (i256(p * x) >> 96n) - 11111509109440967052023855526967n;
  p = (i256(p * x) >> 96n) - 45023709667254063763336534515857n;
  p = (i256(p * x) >> 96n) - 14706773417378608786704636184526n;
  p = i256(p * x - (795164235651350426258249787498n << 96n));
  let q = x + 5573035233440673466300451813936n;
  q = (i256(q * x) >> 96n) + 71694874799317883764090561454958n;
  q = (i256(q * x) >> 96n) + 283447036172924575727196451306956n;
  q = (i256(q * x) >> 96n) + 401686690394027663651624208769553n;
  q = (i256(q * x) >> 96n) + 204048457590392012362485061816622n;
  q = (i256(q * x) >> 96n) + 31853899698501571402653359427138n;
  q = (i256(q * x) >> 96n) + 909429971244387300277376558375n;
  let r = p / q;
  r = i256(r * 1677202110996718588342820967067443963516166n);
  r = i256(r + 16597577552685614221487285958193947469193820559219878177908093499208371n * k);
  r = i256(r + 600920179829731861736702779321621459595472258049074101567377883020018308n);
  return r >> 174n;
}

/** x^y in WAD (Solady: expWad((lnWad(x) * y) / WAD)) */
export function powWad(x: bigint, y: bigint): bigint {
  return expWad((lnWad(x) * y) / WAD);
}

/** Units.muli: sdiv(x · y, d), reverting on overflow */
function muli(x: bigint, y: bigint, d: bigint): bigint {
  const z = x * y;
  if (d === 0n || z !== i256(z)) throw new Error('muli overflow');
  return z / d;
}
const muliWad = (x: bigint, y: bigint): bigint => muli(x, y, WAD);
const diviWad = (x: bigint, y: bigint): bigint => muli(x, WAD, y);

const ONE = WAD;
const TWO = 2n * WAD;
const SQRT2 = 1_414213562373095048n;
const ERFC_DOMAIN_UPPER = 6_240000000000000000n;

/** Gaussian.erfc (Numerical Recipes 2e), as the contracts compute it */
export function erfc(input: bigint): bigint {
  if (input === 0n) return ONE;
  if (input >= ERFC_DOMAIN_UPPER) return 0n;
  if (input <= -ERFC_DOMAIN_UPPER) return TWO;
  const z = input < 0n ? -input : input;
  const t = diviWad(ONE, ONE + (z * WAD) / (2n * WAD)); // 1 / (1 + z/2), z.divWadDown(2e18)
  let step =
    278868070000000000n +
    muliWad(t, -1_135203980000000000n + muliWad(t, 1_488515870000000000n + muliWad(t, -822152230000000000n + muliWad(t, 170872770000000000n))));
  step = muliWad(
    t,
    1_000023680000000000n +
      muliWad(t, 374091960000000000n + muliWad(t, 96784180000000000n + muliWad(t, -186288060000000000n + muliWad(t, step))))
  );
  const k = -1n * muliWad(z, z) - 1_265512230000000000n + step;
  const r = muliWad(t, expWad(k, 'solmate')); // Gaussian uses the Solmate copy
  return input < 0n ? TWO - r : r;
}

/** Gaussian.cdf: the standard normal cdf in WAD, truncating */
export function cdf(x: bigint): bigint {
  const input = (x * ONE) / SQRT2;
  return (erfc(-input) * ONE) / TWO;
}

/** cdf(ln(a / b)) × ratio / 10^(18 + ratioPrecision − outPrecision) — the
 * shape of LibKill.calcAnimosity (out 6) and calcKarma (out 3). The chain
 * reverts on b = 0 and on a = 0 (lnWad of 0); 0 is returned for both. */
export function gaussianShare(
  a: number,
  b: number,
  ratioRaw: number,
  ratioPrecision: number,
  outPrecision: number
): bigint {
  if (!(a > 0) || !(b > 0)) return 0n;
  const ratioWad = (WAD * BigInt(Math.trunc(a))) / BigInt(Math.trunc(b));
  if (ratioWad <= 0n) return 0n;
  const base = cdf(lnWad(ratioWad));
  return (base * BigInt(ratioRaw)) / 10n ** BigInt(18 + ratioPrecision - outPrecision);
}
