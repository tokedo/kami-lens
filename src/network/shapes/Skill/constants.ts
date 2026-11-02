/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
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
