/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/workers/sync/state/index.ts
 * changes:  re-exports the lens-native sliced apply (0.6.3, divergence 13 —
 *           ./apply.ts). The upstream export list is otherwise verbatim.
 */

export {
  create as createStateCache,
  getEntries as getStateCacheEntries,
  removeValues as removeStateValues,
  storeBlock as storeStateBlock,
  storeComponents as storeStateComponents,
  storeEntities as storeStateEntities,
  storeEvent as storeStateEvent,
  storeEvents as storeStateEvents,
  storeValues as storeStateValues,
} from './cache';
export { fromStore as loadStateCacheFromStore, toStore as saveStateCacheToStore } from './loaders';
export { get as getStateStore, getBlockNumber as getStateStoreBlockNumber } from './store';
export { getStateReport } from './utils';

export { applyInSlices, APPLY_SLICE_MS } from './apply';
export type { ApplySliceProfile } from './apply';

export type { StateCache } from './cache';
export type { StateEntry } from './types';
