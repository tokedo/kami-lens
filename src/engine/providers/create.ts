/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/engine/providers/create.ts
 * changes:  daemon-liveness hygiene, three additions:
 *           1. create(): a passive permanent 'error' listener is attached to
 *              the WebSocket at construction. Upstream's reconnect handlers
 *              attach with {once: true}, so a second error on the same
 *              socket (observed live: DNS ENOTFOUND during reconnection)
 *              finds zero listeners and crashes the Node process — a
 *              browser tab survives this, a daemon must too. The reconnect
 *              handlers in createReconnecting are unchanged and still drive
 *              recovery.
 *           2. ensureNetworkIsUp(): each probe is BOUNDED by
 *              NETWORK_CHECK_TIMEOUT_MS (0.5.2). ethers v6 WebSocketProvider
 *              never reconnects (its onclose-reconnect block is commented
 *              out upstream of us, provider-websocket.js) and _start() — the
 *              only resolver of the readiness promise SocketProvider._send
 *              awaits — runs only from websocket.onopen. A socket that never
 *              opens therefore makes getBlockNumber() hang FOREVER: neither
 *              resolve nor reject. Measured: json rejects in 17 ms on
 *              ENOTFOUND, ws is still unsettled after 20 s. Upstream is a
 *              browser tab that the player reloads; a daemon awaited that
 *              promise inside two nested callWithRetry ladders and wedged in
 *              SETUP 0% indefinitely — the network came back, the JSON
 *              provider recovered, and the dead socket held the bootstrap
 *              open with no failure event to retry on (observed live
 *              2026-08-27, laptop-wake restart, 8+ minutes). Bounding the
 *              probe lets the ladder advance, and the ladder already builds
 *              a FRESH provider pair per attempt.
 *           3. initProviders(): a failed attempt DESTROYS the pair it built
 *              before the ladder retries. Without this every failed attempt
 *              leaks a live dead socket and its pending callbacks, because
 *              only the pair that reached the `providers` observable is ever
 *              closed.
 */

import { callWithRetry, observableToComputed, timeoutAfter } from '@mud-classic/utils';
import { BrowserProvider, JsonRpcProvider, Networkish, WebSocketProvider } from 'ethers';
import { IComputedValue, IObservableValue, observable, reaction, runInAction } from 'mobx';

import { isSafariOrIOS } from 'workers/sync/grpcTransport';
import { ConnectionState, MUDJsonRpcProvider, ProviderConfig, Providers } from './types';

/**
 * Create a JsonRpcProvider and WebsocketProvider pair
 *
 * @param config Config for the provider pair (see {@link ProviderConfig}).
 * @returns Provider pair: {
 *   json: JsonRpcProvider,
 *   ws: WebSocketProvider
 * }
 */
export function create({
  chainId,
  jsonRpcUrl,
  wsRpcUrl,
  externalProvider,
  options,
}: ProviderConfig) {
  const network: Networkish = {
    chainId,
    name: 'yominet',
  };
  const useWebSocket = Boolean(wsRpcUrl) && !isSafariOrIOS();
  if (wsRpcUrl && !useWebSocket) {
    console.log('[provider] Safari/iOS detected – skipping WebSocket provider');
  }
  const json = new MUDJsonRpcProvider(jsonRpcUrl, network);
  const ws = useWebSocket ? new WebSocketProvider(wsRpcUrl!, network) : undefined;
  // keep a passive listener so a socket error can never crash the process
  // (Node throws on 'error' events with zero listeners)
  (ws?.websocket as { on?: (event: string, listener: () => void) => void })?.on?.('error', () => {});
  const signer = externalProvider;

  if (options?.pollingInterval) {
    json.pollingInterval = options.pollingInterval;
  }

  return { json, ws, signer };
}

/**
 * Creates a {@link createProvider provider pair} that automatically updates if the config changes
 * and automatically reconnects if the connection is lost.
 *
 * @param config Mobx computed provider config object (see {@link ProviderConfig}).
 * Automatically updates the returned provider pair if the config changes.
 * @returns Automatically reconnecting {@link createProvider provider pair} that updates if the config changes.
 */
export async function createReconnecting(config: IComputedValue<ProviderConfig>) {
  const connected = observable.box<ConnectionState>(ConnectionState.DISCONNECTED);
  const providers = observable.box<Providers>() as IObservableValue<Providers>;
  const disposers: (() => void)[] = [];

  async function initProviders() {
    // Abort if connection is currently being established
    if (connected.get() === ConnectionState.CONNECTING) return;
    // Invalidate current providers
    runInAction(() => connected.set(ConnectionState.CONNECTING));

    // Remove listeners from stale providers and close open connections
    const prevProviders = providers.get();
    prevProviders?.json.removeAllListeners();
    try {
      prevProviders?.ws?.websocket?.close();
    } catch {
      // Ignore errors when closing websocket that was not in an open state
    }

    const conf = config.get();

    // Create new providers
    await callWithRetry(async () => {
      const newProviders = create(conf);
      try {
        // If the connection is not successful, this will throw an error, triggering a retry
        !conf?.options?.skipNetworkCheck &&
          (await ensureNetworkIsUp(newProviders.json, newProviders.ws));
      } catch (e) {
        // banner change 3: this pair never reached `providers`, so nothing
        // else will ever close it. A ws whose socket is dead still holds an
        // open handle and the callbacks queued against it.
        try {
          newProviders.ws?.destroy();
        } catch {
          /* a dead socket may throw on close */
        }
        try {
          newProviders.json.destroy();
        } catch {
          /* same */
        }
        throw e;
      }
      runInAction(() => {
        providers.set(newProviders);
        connected.set(ConnectionState.CONNECTED);
      });
    });
  }

  // Create new providers if config changes
  disposers.push(
    reaction(
      () => config.get(),
      () => initProviders()
    )
  );

  // Reconnect providers in case of error
  disposers.push(
    reaction(
      () => providers.get(),
      (currentProviders) => {
        const wsAny = currentProviders?.ws?.websocket as any;
        if (!wsAny) return;

        const onError = () => {
          initProviders();
        };
        const onClose = () => {
          if (connected.get() === ConnectionState.CONNECTED) {
            console.debug('Reconnecting websocket');
            initProviders();
          }
        };

        if (typeof wsAny.addEventListener === 'function') {
          // Browser WebSocket
          wsAny.addEventListener('error', onError, { once: true });
          wsAny.addEventListener('close', onClose, { once: true });
        } else if (typeof wsAny.once === 'function') {
          // Node "ws" best-effort
          wsAny.once('error', onError);
          wsAny.once('close', onClose);
        } else if (typeof wsAny.on === 'function') {
          // Fallback additive
          wsAny.on('error', onError);
          wsAny.on('close', onClose);
        } else {
          // Last resort: property assignment
          wsAny.onerror = onError;
          wsAny.onclose = onClose;
        }
      }
    )
  );

  // Keep websocket connection alive
  const keepAliveInterval = setInterval(async () => {
    if (connected.get() !== ConnectionState.CONNECTED) return;
    const currentProviders = providers.get();
    if (!currentProviders?.ws) return;
    try {
      await timeoutAfter(currentProviders.ws.getBlockNumber(), 10000, 'Network Request Timed out');
    } catch {
      initProviders();
    }
  }, 10000);
  disposers.push(() => clearInterval(keepAliveInterval));

  await initProviders();

  return {
    connected: observableToComputed(connected),
    providers: observableToComputed(providers),
    dispose: () => {
      for (const disposer of disposers) disposer();
      try {
        providers.get()?.ws?.websocket?.close();
      } catch {
        // Ignore error if websocket is not on OPEN state
      }
    },
  };
}

/** Bound on ONE network probe (0.5.2 — see change 2 in the banner). Matched
 * to the keepalive loop above, which already gives the same read 10 s. A
 * probe that has not answered in ten seconds has not answered; the value of
 * this constant is that there IS one. */
export const NETWORK_CHECK_TIMEOUT_MS = 10_000;

/**
 * Await network to be reachable.
 *
 * @param provider ethers JsonRpcProvider
 * @param wssProvider ethers WebSocketProvider
 * @returns Promise resolving once the network is reachable
 */
export async function ensureNetworkIsUp(
  provider: JsonRpcProvider | BrowserProvider,
  wssProvider?: WebSocketProvider
): Promise<void> {
  const networkInfoPromise = () => {
    return Promise.all([
      timeoutAfter(
        provider.getBlockNumber(),
        NETWORK_CHECK_TIMEOUT_MS,
        'json network check timed out'
      ),
      wssProvider
        ? timeoutAfter(
            wssProvider.getBlockNumber(),
            NETWORK_CHECK_TIMEOUT_MS,
            'ws network check timed out'
          )
        : Promise.resolve(),
    ]);
  };
  await callWithRetry(networkInfoPromise, [], 10, 1000);
  return;
}
