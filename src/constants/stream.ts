/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
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
