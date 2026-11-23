/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/explorer/recipes.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { getAllRecipes, getRecipe, getRecipeByIndex } from 'network/shapes/Recipe';

export const recipes = (world: World, components: Components) => {
  return {
    all: () => getAllRecipes(world, components),
    get: (entity: EntityIndex) => getRecipe(world, components, entity),
    getByIndex: (index: number) => getRecipeByIndex(world, components, index),
    indices: () => Array.from(components.RecipeIndex.values.value.values()),
  };
};
