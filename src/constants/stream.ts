/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/constants/stream.ts
 * changes:  none
 */

import { EntityID } from 'engine/recs';
import { NetworkComponentUpdate, NetworkEvents } from 'workers/types';

export const EmptyNetworkEvent = {
  type: NetworkEvents.NetworkComponentUpdate,
  entity: '0' as EntityID,
  component: 'Void',
  value: undefined,
  blockNumber: 0,
  lastEventInTx: false,
  txHash: 'EmptyNetworkEvent',
  txMetadata: undefined,
} as NetworkComponentUpdate;
