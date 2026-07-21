/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
