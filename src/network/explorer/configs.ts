/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/explorer/configs.ts
 * changes:  none
 */

import { World } from 'engine/recs';

import { Components } from 'network/';
import {
  getConfigFieldValue,
  getConfigFieldValueAddress,
  getConfigFieldValueArray,
} from 'network/shapes/Config';

export const configs = (world: World, components: Components) => {
  return {
    get: (name: string) => getConfigFieldValue(world, components, name),
    getArray: (name: string) => getConfigFieldValueArray(world, components, name),
    getAddress: (name: string) => getConfigFieldValueAddress(world, components, name),
  };
};
