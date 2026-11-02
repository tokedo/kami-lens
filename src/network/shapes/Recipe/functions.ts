/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
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
