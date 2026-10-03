/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
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
