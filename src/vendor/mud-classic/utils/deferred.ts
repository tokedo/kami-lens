/**
 * kami-lens vendored dependency (MIT, compatible with this repo's AGPL-3.0).
 * package:   @mud-classic/utils@0.0.3 — the exact artifact the upstream client
 *            resolves (integrity matches upstream pnpm-lock.yaml at the pin).
 * source:    src/deferred.ts, recovered verbatim from the published artifact's
 *            source maps.
 * copyright: (c) 2022-present Lattice Labs Ltd. (MIT License)
 * changes:   none
 */

/**
 * A convenient way to create a promise with resolve and reject functions.
 * @returns Tuple with resolve function, reject function and promise.
 */
export function deferred<T>(): [(t: T) => void, (t: Error) => void, Promise<T>] {
  let resolve: ((t: T) => void) | null = null;
  let reject: ((t: Error) => void) | null = null;
  const promise = new Promise<T>((r, rj) => {
    resolve = (t: T) => r(t);
    reject = (e: Error) => rj(e);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return [resolve as any, reject as any, promise];
}
