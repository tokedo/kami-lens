// kami-lens shim (not a port): upstream clients/kamiden/index.ts re-exports
// the live gRPC-web client (getClient), stream subscriptions, and an
// IndexedDB tx-error logger. The Kamiden client ports in milestone M4 with
// the rest of the untrusted-text surface (DESIGN §3.4/§3.10); M2 needs only
// what app/cache imports: the generated proto types (ported verbatim in
// ./proto.ts) and getKamidenClient. Upstream's getClient returns null when
// no Kamiden URL is configured and every consumer handles that (e.g.
// app/cache/battles warns and caches empty) — this shim IS that unset-URL
// mode, permanently until M4.
// upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
// path:     packages/client/src/clients/kamiden/index.ts

import type { KamidenServiceClient } from './proto';

export function getKamidenClient(): KamidenServiceClient | null {
  return null;
}

export { KamiMarketBidType } from './proto';

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
