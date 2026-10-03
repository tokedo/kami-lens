/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/network/explorer/addresses.ts
 * changes:  none
 */

import { World } from 'engine/recs';

import { Components } from 'network/';
import { getCompAddr, getSystemAddr } from 'network/shapes/utils/addresses';

export const addresses = (world: World, components: Components) => {
  return {
    components: (id: string) => getCompAddr(world, components, id),
    systems: (id: string) => getSystemAddr(world, components, id),
  };
};
