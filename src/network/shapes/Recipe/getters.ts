/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Recipe/getters.ts
 * changes:  none
 */

import { Has, runQuery, World } from 'engine/recs';

import { Components } from 'network/';
import { NullRecipe } from './constants';
import { get, getRegEntity, Recipe } from './types';

export const getAllRecipes = (world: World, components: Components): Recipe[] => {
  const { RecipeIndex, IsRegistry } = components;
  const entities = Array.from(runQuery([Has(RecipeIndex), Has(IsRegistry)]));
  return entities.map((index) => get(world, components, index));
};

export const getByIndex = (world: World, components: Components, index: number): Recipe => {
  const entity = getRegEntity(world, index);
  if (!entity) return NullRecipe;

  return get(world, components, entity, index);
};
