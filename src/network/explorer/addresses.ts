/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
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
