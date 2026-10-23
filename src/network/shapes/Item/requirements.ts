/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
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
