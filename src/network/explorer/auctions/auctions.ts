/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
