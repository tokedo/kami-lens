/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
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
