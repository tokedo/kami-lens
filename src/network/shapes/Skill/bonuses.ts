/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/shapes/Skill/bonuses.ts
 * changes:  none
 */

import { EntityID, EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { Bonus, getBonusRegistry } from '../Bonus';
import { hashArgs, queryChildrenOf } from '../utils';

// query the Entity Indices of the bonuses of a Skill by its index
export const queryBonuses = (components: Components, skillIndex: number): EntityIndex[] => {
  const anchorID = genBonusAnchorID(skillIndex);
  return queryChildrenOf(components, anchorID);
};

// get the Bonus objects associated with a Skill by its index
export const getBonuses = (world: World, components: Components, skillIndex: number): Bonus[] => {
  const entities = queryBonuses(components, skillIndex);
  const results = entities.map((entity) => getBonusRegistry(world, components, entity));
  // filter out tree bonuses
  return results.filter((bonus) => !bonus.type.startsWith('SKILL_TREE_'));
};

// generate the EntityID of the bonuses parent for a skill
export const genBonusAnchorID = (skillIndex: number): EntityID => {
  return hashArgs(['registry.skill.bonus', skillIndex], ['string', 'uint32']);
};
