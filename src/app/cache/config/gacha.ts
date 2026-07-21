/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/app/cache/config/gacha.ts
 * changes:  none
 */

import { World } from 'engine/recs';

import { Components } from 'network/components';
import { getConfigValue } from '.';

export type MintConstraints = {
  max: number;
  price: number;
  startTs: number;
};

// TODO: figure out where to put this
export type GachaMintConfig = {
  total: number;
  whitelist: MintConstraints;
  public: MintConstraints;
};

// get the config for the gacha ticket mint
export const getMintConfig = (world: World, components: Components): GachaMintConfig => {
  return {
    total: getConfigValue(world, components, 'MINT_MAX_TOTAL'),
    whitelist: {
      max: getConfigValue(world, components, 'MINT_MAX_WL'),
      price: getConfigValue(world, components, 'MINT_PRICE_WL'),
      startTs: getConfigValue(world, components, 'MINT_START_WL'),
    },
    public: {
      max: getConfigValue(world, components, 'MINT_MAX_PUBLIC'),
      price: getConfigValue(world, components, 'MINT_PRICE_PUBLIC'),
      startTs: getConfigValue(world, components, 'MINT_START_PUBLIC'),
    },
  };
};
