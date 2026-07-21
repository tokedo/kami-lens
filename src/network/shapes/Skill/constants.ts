/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Skill/constants.ts
 * changes:  one @ts-expect-error — upstream type defect at the pin (vite
 *           never typechecks): NullSkill omits the `entity` field its type
 *           requires. Body otherwise verbatim.
 */

import { EntityID } from 'engine/recs';

import { Skill } from './types';

// @ts-expect-error upstream defect at the pin: `entity` omitted
export const NullSkill: Skill = {
  ObjectType: 'SKILL',
  id: '0' as EntityID,
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
