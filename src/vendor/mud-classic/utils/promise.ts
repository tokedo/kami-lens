/**
 * kami-lens vendored dependency (MIT, compatible with this repo's AGPL-3.0).
 * package:   @mud-classic/utils@0.0.3 — the exact artifact the upstream client
 *            resolves (integrity matches upstream pnpm-lock.yaml at the pin).
 * source:    src/promise.ts, recovered verbatim from the published artifact's
 *            source maps.
 * copyright: (c) 2022-present Lattice Labs Ltd. (MIT License)
 * changes:   none
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { deferred } from "./deferred";
import { sleep } from "./sleep";

export const range = function* (total = 0, step = 1, from = 0) {
  // eslint-disable-next-line no-empty
  for (let i = 0; i < total; yield from + i++ * step) {}
};

export async function rejectAfter<T>(ms: number, msg: string): Promise<T> {
  await sleep(ms);
  throw new Error(msg);
}

export const timeoutAfter = async <T>(promise: Promise<T>, ms: number, timeoutMsg: string) => {
  return Promise.race([promise, rejectAfter<T>(ms, timeoutMsg)]);
};

export const callWithRetry = <T>(
  fn: (...args: any[]) => Promise<T>,
  args: any[] = [],
  maxRetries = 10,
  retryInterval = 1000
): Promise<T> => {
  const [resolve, reject, promise] = deferred<T>();
  const process = async () => {
    let res: T;
    for (let i = 0; i < maxRetries; i++) {
      try {
        res = await fn(...args);
        resolve(res);
        break;
      } catch (e) {
        if (i < maxRetries - 1) {
          console.info("[CallWithRetry Failed] attempt number=" + i, fn);
          console.error(e);
          await sleep(Math.min(retryInterval * 2 ** i + Math.random() * 100, 15000));
        } else {
          reject(e as unknown as Error);
        }
      }
    }
  };
  process();
  return promise;
};
