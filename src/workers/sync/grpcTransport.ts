/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/workers/sync/grpcTransport.ts
 * changes:  swap point 4 (DESIGN §4.1) — gRPC-web browser transport → Node.
 *           Upstream picks WebsocketTransport on Chromium and
 *           FetchReadableStreamTransport on Safari/iOS (WebKit worker
 *           WebSocket bugs). Node has no browser WebSocket for the ws
 *           transport, but it does have global fetch with readable streams,
 *           so this port always returns the fetch transport — the exact
 *           transport upstream's Safari path uses against the production
 *           server. isSafariOrIOS keeps its upstream contract and returns
 *           false off-browser (its navigator checks are inlined unchanged).
 */

import { grpc } from '@improbable-eng/grpc-web';

/**
 * Returns the appropriate gRPC transport for Node
 * - FetchReadableStreamTransport (upstream's Safari/iOS path)
 */
export function getGrpcTransport(): grpc.TransportFactory {
  return grpc.FetchReadableStreamTransport({ credentials: 'omit' });
}

/**
 * Detects if the current environment is Safari or an iOS WebKit wrapper.
 * Always false under Node (no browser navigator/userAgent match).
 */
export function isSafariOrIOS(): boolean {
  if (typeof navigator === 'undefined') return false;

  const ua = navigator.userAgent;
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    ((navigator as { platform?: string }).platform === 'MacIntel' &&
      (navigator as { maxTouchPoints?: number }).maxTouchPoints! > 1);

  return isSafari || isIOS;
}
