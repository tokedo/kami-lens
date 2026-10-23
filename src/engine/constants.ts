/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
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
