/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/workers/sync/snapshot/create.ts
 * changes:  none
 */

import { createKamigazeClient, KamigazeServiceClient } from 'clients/kamigaze';

// create a KamigazeServiceClient for the SnapshotService
export function create(url: string): KamigazeServiceClient {
  return createKamigazeClient(url);
}
