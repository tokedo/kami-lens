/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/clients/kamiden/index.ts
 * changes:  (M4 — this file replaces the M2 shim that pinned getKamidenClient
 *           to null.) Upstream additionally exports logTxErrorToDB from
 *           ./txErrorLogger — an IndexedDB logger for failed TRANSACTIONS,
 *           acting-side machinery (kami-lens is read-only, DESIGN §2) with a
 *           browser-only store; not ported, so that export is dropped.
 *           configureKamiden is a port addition (swap point 1 — see
 *           ./client.ts header). Everything else is upstream's export
 *           surface verbatim.
 */

export { configureKamiden, getClient as getKamidenClient } from './client';
export { subscribeToFeed, subscribeToMessages } from './subscriptions';

export { KamiMarketBidType } from './proto';

export type { KamidenServiceClient } from './proto';

export type {
  AuctionBuy,
  AuctionBuysRequest,
  AuctionBuysResponse,
  DroptableReveal,
  Feed,
  HarvestEnd,
  KamiCast,
  KamiMarketAccept,
  KamiMarketBid,
  KamiMarketBuy,
  KamiMarketCancel,
  KamiMarketList,
  KamiMarketListing,
  KamiMarketOffer,
  KamiMarketOrder,
  Kill,
  Message,
  Movement,
  RoomRequest,
  RoomResponse,
  SacrificeReveal,
  StreamRequest,
  StreamResponse,
} from './proto';
