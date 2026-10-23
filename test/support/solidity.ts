// kami-lens test support (not a port): the fixed-point math the Kamigotchi
// contracts compute with, transcribed to BigInt so test/formula-parity.test.ts
// can evaluate a contract formula exactly as the chain does.
//
// This file is this repository's own code (AGPL-3.0-only). What it transcribes
// is named per function: the contracts' own utils at
// Asphodel-OS/kamigotchi-open @ 04cb25f8 (packages/contracts/src/utils:
// FixedPointMathLib.sol — Solmate's, AGPL-3.0-only; Gaussian.sol and Units.sol
// — Solstat's, AGPL-3.0-only), and the two libraries the contracts import from
// their package manager at that pin: Solady FixedPointMathLib (pnpm-lock:
// Vectorized/solady 73f13dd1, v0.1.26, MIT) and PRBMath 4.1.0 SD59x18 (MIT).
// The algorithms are reproduced step for step — integer division truncating
// toward zero for signed values (Solidity `/`, EVM sdiv), `>>` on a signed
// value arithmetic (EVM sar), unchecked products wrapped to 256 bits — so a
// result equals the contract's to the last unit. Constants are the libraries'.

export const WAD = 10n ** 18n;

/** an unchecked int256 product/shift, wrapped as the EVM wraps it */
export const i256 = (x: bigint): bigint => BigInt.asIntN(256, x);
/** an unchecked uint256 value */
export const u256 = (x: bigint): bigint => BigInt.asUintN(256, x);

/** Solidity checked uint256 subtraction: reverts below zero. */
export function usub(a: bigint, b: bigint): bigint {
  if (b > a) throw new Error('arithmetic underflow (Solidity 0.8 checked math)');
  return a - b;
}

/** floor(log2(x)) for x > 0 — PRBMath Common.msb / Solmate log2 */
export function msb(x: bigint): bigint {
  if (x <= 0n) throw new Error('msb of a non-positive');
  return BigInt(x.toString(2).length - 1);
}

// ------------------------------------------------- exp / ln (Remco Bloemen)

/** expWad — Solady FixedPointMathLib (and the contracts' Solmate copy, which
 * differs only in where it returns 0 for very negative input: Solady
 * x <= -41446531673892822313, Solmate x <= -42139678854452767551). */
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
  const r = p / q; // sdiv
  return (u256(r) * 3822833074963236453042738258902158003155416615667n) >> (195n - k);
}

/** lnWad — Solady FixedPointMathLib; the Solmate copy computes the same
 * value (same range reduction, same (8, 8) rational approximation). */
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
  let r = p / q; // sdiv
  r = i256(r * 1677202110996718588342820967067443963516166n);
  r = i256(r + 16597577552685614221487285958193947469193820559219878177908093499208371n * k);
  r = i256(r + 600920179829731861736702779321621459595472258049074101567377883020018308n);
  return r >> 174n;
}

/** powWad — Solady: expWad((lnWad(x) * y) / WAD) */
export function powWad(x: bigint, y: bigint): bigint {
  return expWad((lnWad(x) * y) / WAD);
}

// ------------------------------------------------ Solstat Gaussian / Units

/** Units.muli: sdiv(x * y, denominator), reverting on overflow */
const muli = (x: bigint, y: bigint, d: bigint): bigint => {
  const z = x * y;
  if (d === 0n || z !== i256(z)) throw new Error('muli overflow');
  return z / d;
};
export const muliWad = (x: bigint, y: bigint): bigint => muli(x, y, WAD);
export const diviWad = (x: bigint, y: bigint): bigint => muli(x, WAD, y);

const ERFC_A = 1_265512230000000000n;
const ERFC_B = 1_000023680000000000n;
const ERFC_C = 374091960000000000n;
const ERFC_D = 96784180000000000n;
const ERFC_E = -186288060000000000n;
const ERFC_F = 278868070000000000n;
const ERFC_G = -1_135203980000000000n;
const ERFC_H = 1_488515870000000000n;
const ERFC_I = -822152230000000000n;
const ERFC_J = 170872770000000000n;
const ERFC_DOMAIN_UPPER = 6_240000000000000000n;
const SQRT2 = 1_414213562373095048n;
const ONE = WAD;
const TWO = 2n * WAD;

/** Gaussian.erfc (Numerical Recipes 2e, fractional error < 1.2e-7) */
export function erfc(input: bigint): bigint {
  if (input === 0n) return ONE;
  if (input >= ERFC_DOMAIN_UPPER) return 0n;
  if (input <= -ERFC_DOMAIN_UPPER) return TWO;
  const z = input < 0n ? -input : input;
  // z.divWadDown(DOUBLE_WAD) = mulDivDown(z, WAD, 2e18)
  const t = diviWad(ONE, ONE + (z * WAD) / (2n * WAD));
  let step = ERFC_F + muliWad(t, ERFC_G + muliWad(t, ERFC_H + muliWad(t, ERFC_I + muliWad(t, ERFC_J))));
  step = muliWad(
    t,
    ERFC_B + muliWad(t, ERFC_C + muliWad(t, ERFC_D + muliWad(t, ERFC_E + muliWad(t, step))))
  );
  const k = -1n * muliWad(z, z) - ERFC_A + step;
  const exp = expWad(k, 'solmate'); // Gaussian uses the contracts' Solmate copy
  const r = muliWad(t, exp);
  return input < 0n ? TWO - r : r;
}

/** Gaussian.cdf: D(x) = erfc(-x/√2) / 2, truncating */
export function cdf(x: bigint): bigint {
  const input = (x * ONE) / SQRT2;
  return (erfc(-input) * ONE) / TWO;
}

// --------------------------------------------------- PRBMath 4.1.0 SD59x18

const uEXP2_MAX_INPUT = 192n * WAD - 1n;
const uEXP2_MIN_THRESHOLD = -59_794705707972522261n;

/** 2^(2^-k) in 64.64, k = 1..64 — PRBMath Common.exp2's factors, bit 63
 * (0x8000000000000000) first */
const EXP2_FACTORS = [
  0x16a09e667f3bcc909n, 0x1306fe0a31b7152dfn, 0x1172b83c7d517adcen, 0x10b5586cf9890f62an,
  0x1059b0d31585743aen, 0x102c9a3e778060ee7n, 0x10163da9fb33356d8n, 0x100b1afa5abcbed61n,
  0x10058c86da1c09ea2n, 0x1002c605e2e8cec50n, 0x100162f3904051fa1n, 0x1000b175effdc76ban,
  0x100058ba01fb9f96dn, 0x10002c5cc37da9492n, 0x1000162e525ee0547n, 0x10000b17255775c04n,
  0x1000058b91b5bc9aen, 0x100002c5c89d5ec6dn, 0x10000162e43f4f831n, 0x100000b1721bcfc9an,
  0x10000058b90cf1e6en, 0x1000002c5c863b73fn, 0x100000162e430e5a2n, 0x1000000b172183551n,
  0x100000058b90c0b49n, 0x10000002c5c8601ccn, 0x1000000162e42fff0n, 0x10000000b17217fbbn,
  0x1000000058b90bfcen, 0x100000002c5c85fe3n, 0x10000000162e42ff1n, 0x100000000b17217f8n,
  0x10000000058b90bfcn, 0x1000000002c5c85fen, 0x100000000162e42ffn, 0x1000000000b17217fn,
  0x100000000058b90c0n, 0x10000000002c5c860n, 0x1000000000162e430n, 0x10000000000b17218n,
  0x1000000000058b90cn, 0x100000000002c5c86n, 0x10000000000162e43n, 0x100000000000b1721n,
  0x10000000000058b91n, 0x1000000000002c5c8n, 0x100000000000162e4n, 0x1000000000000b172n,
  0x100000000000058b9n, 0x10000000000002c5dn, 0x1000000000000162en, 0x10000000000000b17n,
  0x1000000000000058cn, 0x100000000000002c6n, 0x10000000000000163n, 0x100000000000000b1n,
  0x10000000000000059n, 0x1000000000000002cn, 0x10000000000000016n, 0x1000000000000000bn,
  0x10000000000000006n, 0x10000000000000003n, 0x10000000000000001n, 0x10000000000000001n,
];

/** Common.exp2 on a 192.64-bit input */
function commonExp2(x: bigint): bigint {
  let result = 0x800000000000000000000000000000000000000000000000n;
  for (let i = 0; i < 64; i++) {
    if ((x & (1n << BigInt(63 - i))) > 0n) result = (result * EXP2_FACTORS[i]!) >> 64n;
  }
  result *= WAD;
  return result >> (191n - (x >> 64n));
}

export function sdExp2(x: bigint): bigint {
  if (x < 0n) {
    if (x < uEXP2_MIN_THRESHOLD) return 0n;
    return (WAD * WAD) / sdExp2(-x);
  }
  if (x > uEXP2_MAX_INPUT) throw new Error('PRBMath_SD59x18_Exp2_InputTooBig');
  return commonExp2((x << 64n) / WAD);
}

export function sdLog2(xIn: bigint): bigint {
  let x = xIn;
  if (x <= 0n) throw new Error('PRBMath_SD59x18_Log_InputTooSmall');
  let sign: bigint;
  if (x >= WAD) sign = 1n;
  else {
    sign = -1n;
    x = (WAD * WAD) / x;
  }
  const n = msb(x / WAD);
  let result = n * WAD;
  let y = x >> n;
  if (y === WAD) return result * sign;
  for (let delta = WAD / 2n; delta > 0n; delta >>= 1n) {
    y = (y * y) / WAD;
    if (y >= 2n * WAD) {
      result += delta;
      y >>= 1n;
    }
  }
  return result * sign;
}

const abs = (x: bigint) => (x < 0n ? -x : x);
/** SD59x18 mul: Common.mulDiv18 (floor |x·y| / 1e18) with the sign */
export const sdMul = (x: bigint, y: bigint): bigint => {
  const r = (abs(x) * abs(y)) / WAD;
  return (x < 0n) !== (y < 0n) ? -r : r;
};
/** SD59x18 div: Common.mulDiv (floor |x|·1e18 / |y|) with the sign */
export const sdDiv = (x: bigint, y: bigint): bigint => {
  const r = (abs(x) * WAD) / abs(y);
  return (x < 0n) !== (y < 0n) ? -r : r;
};

export function sdPow(x: bigint, y: bigint): bigint {
  if (x === 0n) return y === 0n ? WAD : 0n;
  if (x === WAD) return WAD;
  if (y === 0n) return WAD;
  if (y === WAD) return x;
  return sdExp2(sdMul(sdLog2(x), y));
}

// ---------------------------------------------------------------- LibGDA

export type GDAParams = {
  targetPrice: bigint;
  startTs: bigint;
  period: bigint;
  /** 1e18 (pre-scaled up from the component's 1e6) */
  decay: bigint;
  rate: bigint;
  prevSold: bigint;
  quantity: bigint;
};

/** LibGDA.calc (libraries/utils/LibGDA.sol): the cost in WAD */
export function gdaCalc(p: GDAParams, now: bigint): bigint {
  const raw = (v: bigint) => v * WAD; // LibFPConverter.rawToSD
  const pTarget = raw(p.targetPrice);
  const qInitial = raw(p.prevSold);
  const qDelta = raw(p.quantity);
  const period = raw(p.period);
  const tDelta = sdDiv(raw(usub(now, p.startTs)), period);
  const decay = p.decay;
  const rate = raw(p.rate);
  let cost = sdMul(sdPow(decay, tDelta - sdDiv(qInitial, rate)), pTarget);
  if (p.quantity > 1n) {
    const one = raw(1n);
    const scale = sdPow(decay, -sdDiv(one, rate));
    const num = sdPow(scale, qDelta) - one;
    const den = scale - one;
    cost = sdDiv(sdMul(cost, num), den);
  }
  return cost;
}

