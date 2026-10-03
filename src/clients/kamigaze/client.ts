/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/clients/kamigaze/client.ts
 * changes:  swap point 1 (DESIGN §4.1) — the getClient() singleton read
 *           import.meta.env.VITE_KAMIGAZE_URL; kami-lens configuration flows
 *           through explicit arguments (src/config.ts), so getClient is not
 *           ported. createKamigazeClient is verbatim (its transport comes
 *           from grpcTransport.ts, which carries swap point 4).
 */

import { createChannel, createClient } from 'nice-grpc-web';

import { getGrpcTransport } from '../../workers/sync/grpcTransport';
import { KamigazeServiceClient, KamigazeServiceDefinition } from './proto';

// Connection reuse is the browser's (HTTP/2), not this map's: it only shares one client
// object per endpoint.
const clientsByUrl = new Map<string, KamigazeServiceClient>();

/**
 * Get or create a KamigazeServiceClient for a given URL.
 */
export function createKamigazeClient(url: string): KamigazeServiceClient {
  const existing = clientsByUrl.get(url);
  if (existing) {
    return existing;
  }

  const channel = createChannel(url, getGrpcTransport());
  const client = createClient(KamigazeServiceDefinition, channel);
  clientsByUrl.set(url, client);
  return client;
}
