/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/shapes/Gacha/mint.ts
 * changes:  none
 */

import { EntityID, World } from 'engine/recs';

import { Components } from 'network/components';
import { getData } from '../Data';

export type MintData = {
  whitelist: number;
  public: number;
  total: number;
};

// get the mint data of an Entity by its ID
export const getMintData = (
  world: World,
  components: Components,
  accountID: EntityID
): MintData => {
  return {
    whitelist: getData(world, components, accountID, 'MINT_NUM_WL'),
    public: getData(world, components, accountID, 'MINT_NUM_PUBLIC'),
    total: getData(world, components, accountID, 'MINT_NUM_TOTAL'),
  };
};
