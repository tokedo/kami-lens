/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/network/shapes/Scavenge/queries.ts
 * changes:  none
 */

import { EntityID, EntityIndex, World } from 'engine/recs';
import { getEntityByHash, hashArgs } from '../utils';

export const queryRegistry = (
  world: World,
  type: string,
  index: number
): EntityIndex | undefined => {
  return getEntityByHash(world, ['registry.scavenge', type, index], ['string', 'string', 'uint32']);
};

export const queryInstance = (
  world: World,
  type: string,
  index: number,
  holderID: EntityID
): EntityIndex | undefined => {
  return getEntityByHash(
    world,
    ['scavenge.instance', type, index, holderID],
    ['string', 'string', 'uint32', 'uint256']
  );
};

// get the ID of the Reward Anchor virtual entity
export const queryRewardAnchor = (regID: EntityID): EntityID => {
  return hashArgs(['scavenge.reward', regID], ['string', 'uint256']);
};
