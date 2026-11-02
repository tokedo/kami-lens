/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
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
