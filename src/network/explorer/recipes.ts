/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
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
