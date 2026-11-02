/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
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
