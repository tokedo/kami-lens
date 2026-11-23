/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
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
