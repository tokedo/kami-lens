/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Item/requirements.ts
 * changes:  none
 */

import { EntityID, World } from 'engine/recs';

import { Components } from 'network/components';
import { Condition, getConditionsOfID } from '../Conditional';
import { genRef, hashArgs } from '../utils';
import { genRefAnchorID } from './utils';

export interface Requirements {
  // burn: Condition[];
  // craft: Condition[];
  use: Condition[];
}

export const getRequirements = (world: World, comps: Components, index: number): Requirements => {
  return {
    use: getActionRequirements(world, comps, index, 'USE'),
  };
};

export const getActionRequirements = (
  world: World,
  comps: Components,
  index: number,
  action: string
): Condition[] => {
  const anchorID = genRequirementAnchor(index, action);
  return getConditionsOfID(world, comps, anchorID);
};

export const genRequirementAnchor = (index: number, action: string): EntityID => {
  const actionID = genRef(action, genRefAnchorID(index));
  return hashArgs(['item.requirement', actionID], ['string', 'uint256']);
};
