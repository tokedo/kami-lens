/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Recipe/constants.ts
 * changes:  one @ts-expect-error — upstream type defect at the pin (vite
 *           never typechecks): NullRecipe omits the `type` field its type
 *           requires. Body otherwise verbatim.
 */

import { EntityID, EntityIndex } from 'engine/recs';

import { Recipe } from './types';

// @ts-expect-error upstream defect at the pin: `type` omitted
export const NullRecipe: Recipe = {
  id: '0' as EntityID,
  index: 0,
  entity: 0 as EntityIndex,
  inputs: [],
  outputs: [],
  experience: 0,
  cost: {
    stamina: 0,
  },
  requirements: [],
};
