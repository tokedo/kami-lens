/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
