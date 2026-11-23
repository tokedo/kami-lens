/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Skill/index.ts
 * changes:  none
 */

export { getBonuses as getSkillBonuses } from './bonuses';
export { NullSkill } from './constants';
export {
  getForHolderByIndex as getHolderSkillByIndex,
  getHolderSkillLevel,
  getForHolder as getHolderSkills,
  getRegistrySkills,
  getByIndex as getSkillByIndex,
} from './getters';
export {
  queryForHolder as queryHolderSkills,
  queryByIndex as querySkillByIndex,
  queryRegistry as querySkillRegistry,
} from './queries';
export { get as getSkill, getInstanceEntity as getSkillInstanceEntity } from './types';

export type { Skill } from './types';
