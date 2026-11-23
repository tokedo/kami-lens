/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
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
