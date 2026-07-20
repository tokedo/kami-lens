/**
 * kami-lens vendored dependency (MIT, compatible with this repo's AGPL-3.0).
 * package:   @mud-classic/utils@0.0.3 — the exact artifact the upstream client
 *            resolves (integrity matches upstream pnpm-lock.yaml at the pin).
 * source:    src/mobx.ts, recovered verbatim from the published artifact's
 *            source maps.
 * copyright: (c) 2022-present Lattice Labs Ltd. (MIT License)
 * changes:   none
 */

import { IComputedValue, IObservableValue, reaction } from "mobx";
import { deferred } from "./deferred";

/**
 * @param comp Computed/Observable value that is either defined or undefined
 * @returns promise that resolves with the first truthy computed value
 */
export async function awaitValue<T>(comp: IComputedValue<T | undefined> | IObservableValue<T | undefined>): Promise<T> {
  const [resolve, , promise] = deferred<T>();

  const dispose = reaction(
    () => comp.get(),
    (value) => {
      if (value) {
        resolve(value);
      }
    },
    { fireImmediately: true }
  );

  const value = await promise;
  // Dispose the reaction once the promise is resolved
  dispose();

  return value;
}
