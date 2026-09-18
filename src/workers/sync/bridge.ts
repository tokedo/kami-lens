/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/workers/sync/bridge.ts
 * forward-port: @ 21f419e63e0a7f6b642c255efeb89dd1c288de1c (sync-affecting
 *           bucket, ahead of the pin — SPEC §4.2). The file does not exist
 *           at the pin; it arrives whole with Asphodel-OS/kamigotchi#2475.
 * changes:  none.
 *           NOTE for the lens, recorded here because the upstream comment
 *           below states the precondition and the lens's gapfill.ts is not
 *           upstream's: reading an EMPTY answer as "out of range" also
 *           requires that fetchGapEvents cannot answer SHORT. In the lens it
 *           can — parseGetEventsSinceResponse SKIPS an undecodable row
 *           (DESIGN §4.1 hygiene divergence) — so a window whose only rows
 *           were undecodable answers non-empty-but-short and the delta never
 *           runs. Counted as tripwires.decodeFailures either way. Flagged at
 *           the 0.6.2 gate 1 as a design question, not resolved here.
 */

import { log } from 'utils/logger';
import { NetworkComponentUpdate } from '../types';
import { StateCache } from './state';

export interface BridgeBootOptions {
  cache: { current: StateCache };
  toBlock: number;
  gap: (fromBlock: number, skipRpcFallback: boolean) => Promise<NetworkComponentUpdate[]>;
  fetchDelta: (cache: StateCache) => Promise<StateCache>;
}

/**
 * Close the gap between a CDN-loaded state image and the live stream.
 *
 * The streamer is asked first over the whole window, with no RPC fallback: the window
 * can be a full export interval and the log scan walks it 50 blocks at a time. An empty
 * answer means the streamer cache no longer reaches back that far, which the snapshot
 * delta fixes - and the streamer then answers a second ask from the snapshot head,
 * because the snapshot itself always trails the chain by its sync period.
 *
 * Reading empty as "out of range" only holds while the streamer refuses asks below its
 * eviction watermark (kamigaze pkg/cache GetEventsSince) rather than answering short, so
 * that streamer must be deployed to an environment before a client here points at its CDN.
 */
export const bridgeBoot = async ({
  cache,
  toBlock,
  gap,
  fetchDelta,
}: BridgeBootOptions): Promise<NetworkComponentUpdate[]> => {
  const from = cache.current.lastKamigazeBlock;
  log.info('[bridge] streamer-first bridge', { from, toBlock });

  let events = await gap(from, true);
  if (events.length === 0 && toBlock > from) {
    try {
      // on a nonce mismatch fetchDelta replaces the cache wholesale, so the returned
      // object is the one to keep
      cache.current = await fetchDelta(cache.current);
      events = await gap(cache.current.lastKamigazeBlock, false);
    } catch (e) {
      log.warn('[bridge] snapshot delta failed, log-scan over the full window', e);
      events = await gap(from, false);
    }
  }

  return events;
};
