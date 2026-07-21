/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/explorer/auctions/pricing.ts
 * changes:  none
 */

import { Auction } from 'network/shapes/Auction';

type AuctionDetails = {
  name: string;
  price: number;
  currency: string;
};

export const getAuctionPrices = (auctions: Auction[]): AuctionDetails[] => {
  return auctions.map((auction) => {
    const name = auction.auctionItem?.name ?? 'Unknown';
    const currency = auction.paymentItem?.name ?? 'Unknown';
    const now = Date.now() / 1000;
    const prevSold = auction.supply.sold;
    const price = calcPrice(auction, now, prevSold);
    return { name, price, currency };
  });
};

// just a copy of the calcPrice function in the cache
export const calcPrice = (auction: Auction, time: number, prevSold: number, amt = 1) => {
  if (!auction.auctionItem?.index) return 0;
  const value = auction.params.value;
  const period = auction.params.period;
  const decay = auction.params.decay;
  const rate = auction.params.rate;

  const tDelta = (time - auction.time.start) / period;

  let price = value * decay ** (tDelta - prevSold / rate);
  if (amt > 1) {
    const scale = decay ** (-1 / rate);
    const num = scale ** amt - 1.0;
    const den = scale - 1.0;
    price = (price * num) / den;
  }

  return Math.ceil(price);
};
