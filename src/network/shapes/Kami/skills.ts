/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/shapes/Kami/skills.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';
import { Components } from 'network/components';
import { queryHolderSkills } from '../Skill';
import { getSkillIndex, getSkillPoints } from '../utils/component';

export interface Investment {
  index: number;
  points: number;
}

export interface Skills {
  points: number;
  investments: Investment[];
}

export const getSkills = (world: World, components: Components, entity: EntityIndex): Skills => {
  const id = world.entities[entity];

  // get the skill instance entities associated with this holder
  const investmentEntities = queryHolderSkills(components, id);
  const investments = investmentEntities.map((instanceEntity) => {
    return {
      index: getSkillIndex(components, instanceEntity),
      points: getSkillPoints(components, instanceEntity),
    };
  });

  return {
    points: getSkillPoints(components, entity),
    investments,
  };
};
