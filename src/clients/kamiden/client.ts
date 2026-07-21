/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/clients/kamiden/client.ts
 * changes:  two swaps, both on the record (DESIGN §4.1 swap point 1 +
 *           PORT_PLAN M4 lifecycle clause):
 *           1. Config: upstream's getClient() reads
 *              import.meta.env.VITE_KAMIGAZE_URL — the Kamiden channel is
 *              deliberately created on the KAMIGAZE url (both gRPC services
 *              share the endpoint at the pin; getClient returns null when
 *              it is unset and every consumer handles null). kami-lens
 *              config flows through explicit arguments: the daemon calls
 *              configureKamiden(url | undefined) once at startup
 *              (src/config.ts defaults kamidenUrl to the kamigazeUrl —
 *              same endpoint, upstream parity) and getClient() keeps its
 *              upstream contract: the client when configured, null when
 *              not.
 *           2. Lifecycle: upstream starts a perennial 5 s-retry
 *              SubscribeToStream loop as a side effect of the first
 *              getClient() call (the module-singleton setupSubscription).
 *              The port removes that side effect entirely — the stream is
 *              daemon-supervised with explicit start/stop in
 *              src/kamiden.ts (DESIGN §3.2 soft-dependency clause), which
 *              preserves the 5 s retry cadence and the Feed dispatch to
 *              subscriptions.ts callbacks, and drops Message frames at
 *              ingestion (§3.10 — the daemon never ingests chat from the
 *              stream).
 *           Channel construction is verbatim (nice-grpc-web createChannel/
 *           createClient over the ported transport, which carries swap
 *           point 4), plus URL-keyed client reuse exactly as the ported
 *           kamigaze client does.
 */

import { createChannel, createClient } from 'nice-grpc-web';

import { getGrpcTransport } from '../../workers/sync/grpcTransport';
import { KamidenServiceClient, KamidenServiceDefinition } from './proto';

// Reuse clients by URL to avoid recreating channels on each call
const clientsByUrl = new Map<string, KamidenServiceClient>();

let configuredUrl: string | undefined;

/** Daemon-side configuration (replaces the import.meta.env read). Passing
 * undefined is upstream's unset-URL mode: getClient() returns null and
 * every consumer takes its documented null path. */
export function configureKamiden(url: string | undefined): void {
  configuredUrl = url;
}

export function getClient(): KamidenServiceClient | null {
  if (!configuredUrl) return null; // null when kamiden url is not set

  let client = clientsByUrl.get(configuredUrl);
  if (!client) {
    const channel = createChannel(configuredUrl, getGrpcTransport());
    client = createClient(KamidenServiceDefinition, channel);
    clientsByUrl.set(configuredUrl, client);
  }
  return client;
}
