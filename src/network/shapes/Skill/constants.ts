/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Skill/constants.ts
 * changes:  none
 */

import { EntityID, EntityIndex } from 'engine/recs';

import { Skill } from './types';

export const NullSkill: Skill = {
  ObjectType: 'SKILL',
  id: '0' as EntityID,
  entity: 0 as EntityIndex,
  index: 0,
  name: '',
  description: '',
  image: '',
  cost: 0,
  max: 0,
  tier: 0,
  type: 'NONE',
  bonuses: [],
  requirements: [],
};
