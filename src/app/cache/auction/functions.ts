/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/app/cache/auction/functions.ts
 * changes:  Date.now() → clock.now() at 1 call site plus the
 *           clock import (§3.8: offset-corrected stream clock, not naive
 *           wall clock — see src/clock.ts). Body otherwise verbatim.
 */

import * as clock from 'clock';
import { Auction } from 'network/shapes/Auction';

// calculate the cost to buy N items from an auction Now
export const calcCost = (auction: Auction, amt: number) => {
  if (amt <= 0) return 0;

  let ts = clock.now() / 1000;
  const startTs = auction.time.start;
  if (startTs > ts) ts = startTs;

  const prevSold = auction.supply.sold;
  return calcPrice(auction, ts, prevSold, amt);
};

// calculate the price of the auction at a given time and balance sold
// used primarily to calculate price history
// NOTE: this may need to be updated to support 256 bit math
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
