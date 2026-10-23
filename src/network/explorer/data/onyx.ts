/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/explorer/data/onyx.ts
 * changes:  none
 */

import { World } from 'engine/recs';

import { Components } from 'network/';
import {
  getOnyxRenameSpend,
  getOnyxRespecSpend,
  getOnyxReviveSpend,
  getOnyxSpends,
} from 'network/shapes/Data';

export const onyx = (world: World, comps: Components) => {
  return {
    all: () => getOnyxSpends(world, comps),
    rename: () => getOnyxRenameSpend(world, comps),
    respec: () => getOnyxRespecSpend(world, comps),
    revive: () => getOnyxReviveSpend(world, comps),
  };
};
