/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/network/explorer/skills.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { getRegistrySkills, getSkill, getSkillByIndex } from 'network/shapes/Skill';

export const skills = (world: World, components: Components) => {
  return {
    all: () => getRegistrySkills(world, components),
    get: (entity: EntityIndex) => getSkill(world, components, entity),
    getByIndex: (index: number) => getSkillByIndex(world, components, index),
    indices: () => Array.from(components.SkillIndex.values.value.values()),
  };
};
