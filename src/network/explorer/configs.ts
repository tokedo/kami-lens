/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
