/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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

// Reuse clients by URL to avoid recreating channels on each call
const clientsByUrl = new Map<string, KamigazeServiceClient>();

/**
 * Get or create a KamigazeServiceClient for a given URL.
 * Clients are reused by URL to preserve gRPC channels across reconnections.
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
