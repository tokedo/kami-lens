/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/network/shapes/Node/multiplier.ts
 * changes:  none
 */

// harvest multiplier K, per mille (1000 = today's output). mirrors LibNode and LibHarvest: node and
// harvest values hold K in the low 16 bits
export const MULT_PREC = 1000;

const M16 = (1n << 16n) - 1n;

// the K stored on a node or on a harvest copy. a node is created with its K and has no default, and a
// stored K is never 0, so 0 means none stored
export const getStoredMultiplier = (raw: string | bigint | number | undefined): number => {
  if (raw === undefined) return 0;
  return Number(BigInt(raw) & M16);
};

// whether a harvest has its copy: a harvest from before K has none and pays its node's current K
export const hasStoredCopy = (raw: string | bigint | number | undefined): boolean => {
  return getStoredMultiplier(raw) !== 0;
};

// scale an amount or a rate by K, without rounding (balances round down in calcs)
export const scaleByMultiplier = (k: number, amount: number): number => (amount * k) / MULT_PREC;

// the label for a node's K: "×0.8", "×2.5"; empty at 1.0
export const formatMultiplier = (k: number): string => {
  return k === MULT_PREC ? '' : `×${k / MULT_PREC}`;
};
