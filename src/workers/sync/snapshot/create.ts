/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/workers/sync/snapshot/create.ts
 * changes:  none
 */

import { createKamigazeClient, KamigazeServiceClient } from 'clients/kamigaze';

// create a KamigazeServiceClient for the SnapshotService
export function create(url: string): KamigazeServiceClient {
  return createKamigazeClient(url);
}
