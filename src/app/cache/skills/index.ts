/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
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
