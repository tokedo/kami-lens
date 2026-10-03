/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/workers/sync/grpcTransport.ts
 * changes:  swap point 4 (DESIGN §4.1) — gRPC-web browser transport → Node.
 *           Since this pin upstream returns FetchReadableStreamTransport
 *           for every browser (it previously picked WebsocketTransport on
 *           Chromium), so the transport choice is now upstream's own; Node
 *           has the global fetch with readable streams it needs.
 *           isSafariOrIOS keeps its upstream contract and returns false
 *           off-browser (its navigator checks are inlined unchanged, with
 *           casts for Node's navigator type).
 *           The @improbable-eng/grpc-web import uses default-import CJS
 *           interop — Node's ESM loader cannot see the package's named
 *           export (vite handled this for the browser build) — and `self`
 *           is aliased to globalThis before the transport is constructed:
 *           the library addresses fetch/Headers through the worker global,
 *           and Node 20+ provides them all on globalThis.
 */

import grpcWebPkg from '@improbable-eng/grpc-web';
import type { grpc } from '@improbable-eng/grpc-web';

const { grpc: grpcWeb } = grpcWebPkg as unknown as { grpc: typeof grpc };

if (typeof (globalThis as { self?: unknown }).self === 'undefined') {
  (globalThis as { self?: unknown }).self = globalThis;
}

/**
 * gRPC-web transport for all browsers.
 * Fetch multiplexes every RPC onto the browser's existing HTTP/2 connection;
 * the WebSocket transport opened a fresh TCP+TLS handshake per call.
 */
export function getGrpcTransport(): grpc.TransportFactory {
  return grpcWeb.FetchReadableStreamTransport({ credentials: 'omit' });
}

/**
 * Detects if the current browser is Safari or an iOS WebKit wrapper.
 * Needed because WebKit's WebSocket implementation inside workers is unreliable.
 * (Under Node there is no browser navigator: false.)
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
