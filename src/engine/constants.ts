/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/engine/constants.ts
 * changes:  none
 */

import { EntityID } from 'engine/recs';

export const GodID = '0x060d' as EntityID;

export enum SyncState {
  CONNECTING,
  SETUP,
  BACKFILL,
  GAPFILL,
  INITIALIZE,
  LIVE,
  FAILED,
}

export type SyncStatus = {
  state: SyncState;
  msg: string;
  percentage: number;
};
