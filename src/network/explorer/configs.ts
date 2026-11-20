/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
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
