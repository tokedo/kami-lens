/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/utils/numbers/bigint.ts
 * changes:  none
 */

export const parseBigIntSafe = (value: unknown): bigint | undefined => {
  if (value === undefined || value === null) return undefined;
  try {
    return BigInt(value.toString());
  } catch {
    return undefined;
  }
};

export const toBigInt = (value: unknown): bigint => {
  const parsed = parseBigIntSafe(value);
  if (parsed !== undefined) return parsed;
  throw new Error('RPC returned an invalid numeric value');
};
