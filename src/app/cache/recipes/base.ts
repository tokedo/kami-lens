/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/app/cache/recipes/base.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { getRecipe, Recipe } from 'network/shapes/Recipe';
import { queryForAllRecipes } from 'network/shapes/Recipe/queries';
import { getItemByIndex } from '../item';

export const RecipeCache = new Map<EntityIndex, Recipe>();

export const get = (world: World, comps: Components, entity: EntityIndex) => {
  if (!RecipeCache.has(entity)) process(world, comps, entity);

  // automatically populate the item details for inputs and outputs
  const recipe = RecipeCache.get(entity)!;
  recipe.inputs.forEach((input) => (input.item = getItemByIndex(world, comps, input.index)));
  recipe.outputs.forEach((output) => (output.item = getItemByIndex(world, comps, output.index)));

  return RecipeCache.get(entity)!;
};

export const process = (world: World, comps: Components, entity: EntityIndex) => {
  const recipe = getRecipe(world, comps, entity);
  RecipeCache.set(entity, recipe);
};

export const getAll = (world: World, comps: Components) => {
  const entities = queryForAllRecipes(comps);
  return entities.map((entity) => get(world, comps, entity));
};
