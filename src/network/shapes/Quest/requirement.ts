/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Quest/requirement.ts
 * changes:  none
 */

import { World } from 'engine/recs';

import { Components } from 'network/';
import { Condition } from '../Conditional';
import { getConditionsOf } from '../Conditional/queries';

export interface Requirement extends Condition {}

// Get the Entity Indices of the Requirements of a Quest
export const getRequirements = (
  world: World,
  components: Components,
  questIndex: number
): Requirement[] => {
  return getConditionsOf(world, components, 'registry.quest.requirement', questIndex);
};
