/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/explorer/auctions/auctions.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { getAllAuctions, getAuction, getAuctionByIndex } from 'network/shapes/Auction';
import { getAuctionPrices } from './pricing';

const AuctionOptions = { auctionItem: true, paymentItem: true };
export const auctions = (world: World, components: Components) => {
  return {
    all: () => getAllAuctions(world, components, AuctionOptions),
    get: (entity: EntityIndex) => getAuction(world, components, entity, AuctionOptions),
    getByIndex: (index: number) => getAuctionByIndex(world, components, index, AuctionOptions),
    getPrices: () => {
      const auctions = getAllAuctions(world, components, AuctionOptions);
      return getAuctionPrices(auctions);
    },
  };
};
