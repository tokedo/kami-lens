/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Gacha/functions.ts
 * changes:  none
 */

import { EntityID, World } from 'engine/recs';

import { Components } from 'network/';
import { Commit, getHolderCommits } from '../Commit';

export const getGachaCommits = (
  world: World,
  components: Components,
  accountID: EntityID
): Commit[] => {
  return getHolderCommits(world, components, 'GACHA_COMMIT', accountID);
};
