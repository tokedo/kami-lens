/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/workers/sync/state/utils.ts
 * changes:  none
 */

import { StateCache } from './cache';

export type StateReport = {
  blockNumber: number;
  numComponents: number;
  numEntities: number;
  numStateEntries: number;
  kamigaze: {
    lastBlock: number;
    lastEntity: number;
    lastComponent: number;
    kamigazeNonce: number;
  };
};

// gets the overview report of the StateCache
export const getStateReport = (stateCache: StateCache): StateReport => {
  return {
    blockNumber: stateCache.blockNumber,
    numComponents: stateCache.components.length,
    numEntities: stateCache.entities.length,
    numStateEntries: stateCache.state.size,
    kamigaze: {
      lastBlock: stateCache.lastKamigazeBlock,
      lastEntity: stateCache.lastKamigazeEntity,
      lastComponent: stateCache.lastKamigazeComponent,
      kamigazeNonce: stateCache.kamigazeNonce,
    },
  };
};
