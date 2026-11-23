/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
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
