/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Recipe/constants.ts
 * changes:  none
 */

import { EntityID, EntityIndex } from 'engine/recs';

import { Recipe } from './types';

export const NullRecipe: Recipe = {
  id: '0' as EntityID,
  index: 0,
  entity: 0 as EntityIndex,
  type: '',
  inputs: [],
  outputs: [],
  experience: 0,
  cost: {
    stamina: 0,
  },
  requirements: [],
};
