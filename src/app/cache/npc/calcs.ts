/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/app/cache/npc/calcs.ts
 * changes:  Date.now() → clock.now() at 1 call site plus the
 *           clock import (§3.8: offset-corrected stream clock, not naive
 *           wall clock — see src/clock.ts).
 *           1.1.0 (§3.19) — two corrections to the chain's integers
 *           (LibListing at the pin): calcBuyPriceGDA clamps the elapsed time
 *           to LibListing.gdaCapSeconds, `prevSold·period/rate + 3·period` in
 *           WHOLE seconds (integer division), on whole-second time (the
 *           chain's block.timestamp), where the client clamped the exponent
 *           at exactly 3 periods — its price read one unit low whenever the
 *           clamp bound and prevSold·period/rate was not whole; and
 *           calcSellPrice floors a SCALED price, `(buyPrice · scale) / 1e9`,
 *           where the client served the fractional product. Body otherwise
 *           verbatim.
 */

import * as clock from 'clock';
import { Listing } from 'network/shapes/Listing';

// mirrors LibListing.MAX_DEFICIT_PERIODS: GDA deficit is clamped on-chain, giving
// a price floor of value × decay^3. The mirror MUST match or the shop displays a
// lower price than the contract charges.
const MAX_DEFICIT_PERIODS = 3;

// calculate the buy price of a listing based on amt purchased
// TODO: determine rounding rules for erc20 denominations
export const calcBuyPrice = (listing: Listing, amt: number) => {
  if (!listing.buy || amt == 0) return 0;
  const pricing = listing.buy;
  const type = pricing.type;
  const value = listing.value;

  let result = 0;
  if (type === 'FIXED') result = Math.round(value * amt * 100) / 100;
  else if (type === 'GDA') result = calcBuyPriceGDA(listing, amt);
  else console.warn('calcBuyPrice(): invalid pricing type', pricing);

  return result;
};

// assume we are processing a listing with a GDA-based buy price
// TODO: determine rounding rules for erc20 denominations
export const calcBuyPriceGDA = (listing: Listing, amt: number) => {
  // kami-lens (1.1.0): whole seconds, as block.timestamp is
  const now = Math.floor(clock.now() / 1000);

  const value = listing.value;
  const pricing = listing.buy!;
  const period = pricing?.period;
  const decay = pricing?.decay;
  const rate = pricing?.rate;
  const prevSold = listing.balance;

  if (!period || !decay || !rate) {
    console.warn('calcBuyPriceGDA(): invalid GDA pricing for listing', listing);
    return 0;
  }

  // kami-lens (1.1.0): LibListing.calcBuyPrice's clamp, in WHOLE seconds —
  // `if (block.timestamp − startTs > cap) startTs = block.timestamp − cap`
  // with cap = gdaCapSeconds = prevSold·period/rate (integer) + 3·period
  const capSeconds = Math.floor((prevSold * period) / rate) + MAX_DEFICIT_PERIODS * period;
  const elapsed = Math.min(now - listing.startTime, capSeconds);
  const tDelta = elapsed / period; // # periods

  // deficit clamp mirrors the on-chain floor (value × decay^MAX_DEFICIT_PERIODS)
  const deficit = tDelta - prevSold / rate;
  let price = value * decay ** deficit;
  if (amt > 1) {
    const scale = decay ** (-1 / rate);
    const num = scale ** amt - 1.0;
    const den = scale - 1.0;
    price = (price * num) / den;
  }

  // contract charges at least 1 currency per unit
  return Math.max(amt, Math.ceil(price));
};

// calculate the sell price of a listing based on amt sold
export const calcSellPrice = (listing: Listing, amt: number) => {
  if (!listing.sell || amt == 0) return 0;
  const pricing = listing.sell;
  const value = listing.value;

  let result = 0;
  if (pricing.type === 'FIXED') {
    result = value * amt;
  } else if (pricing.type === 'SCALED') {
    const scale = pricing?.scale ?? 0;
    // kami-lens (1.1.0): LibListing.calcSellPrice — (buyPrice · scale) / 1e9,
    // floored, with scale back at its raw 1e9 value (getScale(…, 9))
    const buy = BigInt(Math.trunc(calcBuyPrice(listing, amt)));
    result = Number((buy * BigInt(Math.round(scale * 1e9))) / 1_000_000_000n);
  } else console.warn('calcSellPrice(): invalid pricing type', pricing);

  return result;
};
