/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
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
