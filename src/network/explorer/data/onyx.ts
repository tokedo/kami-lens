/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
