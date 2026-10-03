/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/network/shapes/Auction/index.ts
 * changes:  none
 */

/// Shape library for unidirectional (buy only) Discrete Gradual Dutch Auctions

export { NullAuction } from './constants';
export { getAll as getAllAuctions, getByIndex as getAuctionByIndex } from './getters';
export { query as queryAuctions } from './queries';
export { get as getAuction } from './types';

export type { Options as AuctionOptions } from './queries';
export type { Auction } from './types';
