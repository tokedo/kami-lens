/**
 * kami-lens vendored dependency (MIT, compatible with this repo's AGPL-3.0).
 * package:   @mud-classic/utils@0.0.3 — the exact artifact the upstream client
 *            resolves (integrity matches upstream pnpm-lock.yaml at the pin).
 * source:    src/arrays.ts, recovered verbatim from the published artifact's
 *            source maps.
 * copyright: (c) 2022-present Lattice Labs Ltd. (MIT License)
 * changes:   none
 */

/**
 * TypeScript type guard to assert the type of a non-empty array
 * @param array Any array to check for non-emptiness
 * @returns True if the empty is non-empty, else false. TypeScript accepts the array as non-empty after the assertion.
 */
export function isNotEmpty<T>(array: T[]): array is [T, ...T[]] {
  if (array.length === 0) return false;
  return true;
}

/**
 * Filters undefined values from an array and lets TypeScript know the resulting array
 * does not have undefined values
 * @param array Array potentially including undefined values
 * @returns Array without undefined values
 */
export function filterNullishValues<T>(array: (T | undefined)[]): T[] {
  return array.filter((value) => value != null) as T[];
}
