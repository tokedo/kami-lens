/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/workers/sync/bridge.ts
 * forward-port: @ 21f419e63e0a7f6b642c255efeb89dd1c288de1c (sync-affecting
 *           bucket, ahead of the pin — SPEC §4.2). The file does not exist
 *           at the pin; it arrives whole with Asphodel-OS/kamigotchi#2475.
 * changes:  divergence 12 (0.6.2 ruling) — THE BRIDGE IS DELTA-FIRST HERE,
 *           where upstream's is streamer-first. Upstream asks the streamer
 *           over the whole window with the RPC fallback off and reads an
 *           EMPTY answer as "the streamer's cache no longer reaches back that
 *           far", running the snapshot delta only then. That inference does
 *           not hold in the lens and the consequence of its failing is the
 *           L-1 class, so it is not kept. Three reasons, in order of weight:
 *             (a) "empty" conflates four different facts. The streamer
 *                 REFUSED the ask (upstream's intended meaning); the gRPC
 *                 call THREW and fetchGapEvents swallowed it to [] because
 *                 the RPC fallback was off; the answer was genuinely empty;
 *                 or — lens-specific — the answer was SHORT, because
 *                 parseGetEventsSinceResponse skips an undecodable row
 *                 (DESIGN §4.1 hygiene divergence) rather than aborting the
 *                 load the way upstream does. Nothing downstream can tell
 *                 them apart, and `latestBlock` rides on the response
 *                 unread.
 *             (b) A short answer is silent and PERMANENT. The whole bridge
 *                 window sits BELOW the reconcile baseline that is seeded
 *                 immediately after it (§3.17, divergence 7/9), and below
 *                 that baseline every reconcile tick is a counted no-op by
 *                 design — so nothing ever re-reads those blocks. The daemon
 *                 would reach LIVE, report `degraded: []`, and serve a hole.
 *                 That is exactly the 2026-09-06 failure (L-1).
 *             (c) The delta is not the expensive path it is being avoided
 *                 as. It is the same partial `fetchSnapshot` the daemon's
 *                 10-minute checkpoint already runs and already trusts, now
 *                 with the #2455 rewind; Carrot confirmed partial loads stay
 *                 on the snapshot service. A CDN-loaded cache carries
 *                 exactly the cursors a partial load needs
 *                 (lastKamigazeBlock/Nonce/Entity/Component all set by
 *                 fetchFromCdn), so the delta sees it as an ordinary warm
 *                 cache, removals included.
 *           So: delta ALWAYS, then the ordinary fillGap from the delta head,
 *           and never `skipRpcFallback` anywhere on this path — which is why
 *           the `gap` callback below takes no such flag. Upstream's comment
 *           and its streamer-first ordering are therefore NOT preserved
 *           verbatim; everything else about the file is.
 */

import { log } from 'utils/logger';
import { NetworkComponentUpdate } from '../types';
import { StateCache } from './state';

export interface BridgeBootOptions {
  cache: { current: StateCache };
  toBlock: number;
  /** The ordinary bootstrap gap-fill: streamer first, RPC fallback ON,
   * chain-authoritative when the streamer cannot answer. Deliberately NOT
   * parameterised by `skipRpcFallback` — see divergence 12 above. */
  gap: (fromBlock: number) => Promise<NetworkComponentUpdate[]>;
  fetchDelta: (cache: StateCache) => Promise<StateCache>;
}

/**
 * Close the gap between a CDN-loaded state image and the live stream.
 *
 * The image is stamped at the exporter's block, which trails the snapshot
 * service, which in turn trails the chain by its own sync period. So there are
 * two gaps, not one, and they are closed by the two mechanisms that own them:
 *
 *   1. THE SNAPSHOT DELTA, always. It carries the image from the exporter's
 *      block to the snapshot service's head — values, removals, entities and
 *      any new components — and it is the only thing that can, because those
 *      are state rows and not events. On a nonce mismatch it replaces the
 *      cache wholesale, so the object it RETURNS is the one to keep.
 *   2. THE ORDINARY GAP-FILL, from the delta's head to the stream's start.
 *      That window is only the snapshot service's sync period, so the 50-block
 *      log scan behind it is cheap. Streamer first, RPC fallback ON.
 *
 * If the delta THROWS, the gap-fill covers the whole window instead — slow
 * (about 7,200 blocks, so ~144 getLogs calls at worst) but chain-authoritative,
 * which is the property that matters when the snapshot service is the thing
 * that just failed.
 */
export const bridgeBoot = async ({
  cache,
  toBlock,
  gap,
  fetchDelta,
}: BridgeBootOptions): Promise<NetworkComponentUpdate[]> => {
  const from = cache.current.lastKamigazeBlock;
  log.info('[bridge] delta-first bridge', { from, toBlock });

  let gapFrom = from;
  try {
    // on a nonce mismatch fetchDelta replaces the cache wholesale, so the returned
    // object is the one to keep
    cache.current = await fetchDelta(cache.current);
    gapFrom = cache.current.lastKamigazeBlock;
    log.info('[bridge] snapshot delta applied', {
      from,
      to: gapFrom,
      blocks: gapFrom - from,
      toBlock,
    });
  } catch (e) {
    log.warn(
      '[bridge] snapshot delta FAILED — gap-filling the full window with RPC on',
      { from, toBlock, blocks: toBlock - from },
      e
    );
  }

  return gap(gapFrom);
};
