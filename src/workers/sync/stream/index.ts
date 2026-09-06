/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/workers/sync/stream/index.ts
 * changes:  0.6.0 re-exports the chain-authoritative recovery primitive and
 *           its head source (heal.ts, a kami-lens native module — DESIGN
 *           §3.17); upstream has no such module. Everything else verbatim.
 */

export {
  createStream,
  HEALTH_CHECK_BUFFER_MS,
  KEEPALIVE_INTERVAL_MS,
  RATE_LIMIT_DELAY_CAP_MS,
  RECONCILE_INTERVAL_MS,
  retryDelayFor,
  type FetchWorldEvents,
  type StreamClient,
  type StreamOptions,
} from './stream';
export {
  chunkRanges,
  GAP_RPC_MAX_BLOCKS,
  HEAL_CHUNK_BLOCKS,
  healRange,
  RPC_HEAD_POLL_MS,
  RPC_HEAD_WAIT_MS,
  settleHeal,
  abandonHeal,
  type HealResult,
  type RpcHeadSource,
} from './heal';
export { createTransformWorldEvents, type TransformWorldEvents } from './transform';
export { fetchGapEvents, fillGap, type FetchGapEventsOptions, type FillGapOptions } from './gapfill';
