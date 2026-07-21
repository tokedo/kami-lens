/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Recipe/functions.ts
 * changes:  none
 */

import { EntityID, World } from 'engine/recs';

import { Components } from 'network/';
import { getItemBalance } from '../Item';
import { Recipe } from './types';

// check whether an account has all the ingredients for an redcipe in inventory
export const hasIngredients = (
  world: World,
  components: Components,
  recipe: Recipe,
  accID: EntityID
): boolean => {
  return recipe.inputs.every(
    (ing) => getItemBalance(world, components, accID, ing.index) >= ing.amount
  );
};
