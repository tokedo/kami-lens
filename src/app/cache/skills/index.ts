/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/app/cache/skills/index.ts
 * changes:  none
 */

export {
  get as getSkill,
  getByIndex as getSkillByIndex,
  initialize as initializeSkills,
} from './base';
export {
  getHolderTreePoints as getHolderSkillTreePoints,
  getInstance as getSkillInstance,
  getTreePointsRequirement as getSkillTreePointsRequirement,
  getUpgradeError as getSkillUpgradeError,
  parseRequirementText as parseSkillRequirementText,
} from './functions';

export type { Skill } from 'network/shapes/Skill';
