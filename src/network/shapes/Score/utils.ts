/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Score/utils.ts
 * changes:  none
 */

import { EntityID, EntityIndex } from 'engine/recs';

import { getEntityByHash, hashArgs } from '../utils';

// standardized Object shape of a Score Entity
export interface Score {
  holderID: EntityID;
  value: number;
}

export interface ScoresFilter {
  epoch: number;
  index: number;
  type: string;
}

export const getEntity = (
  world: any,
  holderID: EntityID,
  epoch: number,
  index: number,
  field: string
): EntityIndex | undefined => {
  return getEntityByHash(
    world,
    ['is.score', holderID, epoch, index, field],
    ['string', 'uint256', 'uint256', 'uint32', 'string']
  );
};

export const getType = (epoch: number, index: number, type: string): EntityID => {
  return hashArgs(
    ['score.type', epoch, index, type],
    ['string', 'uint256', 'uint32', 'string'],
    true
  );
};

export const getTotalID = (epoch: number, index: number, type: string): EntityID => {
  const typeID = getType(epoch, index, type);
  return hashArgs(['score.total', typeID], ['string', 'uint256']);
};
