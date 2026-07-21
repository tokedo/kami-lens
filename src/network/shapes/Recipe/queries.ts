/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Recipe/queries.ts
 * changes:  none
 */

import { EntityIndex, Has, HasValue, QueryFragment, runQuery } from 'engine/recs';

import { Components } from 'network/';

// get all recipes
export const queryForAllRecipes = (components: Components): EntityIndex[] => {
  const { RecipeIndex, IsRegistry } = components;
  return Array.from(runQuery([Has(RecipeIndex), Has(IsRegistry)]));
};

// generalised query
export type QueryOptions = {
  npc: number; // passed in as index
  node: number; // passed in as index
};

export const query = (components: Components, options?: QueryOptions): EntityIndex[] => {
  const { RecipeIndex, NodeIndex, NPCIndex, EntityType } = components;

  const toQuery: QueryFragment[] = [];
  if (options?.npc != undefined)
    toQuery.push(HasValue(NPCIndex, { value: options.npc }), Has(RecipeIndex));
  if (options?.node != undefined)
    toQuery.push(HasValue(NodeIndex, { value: options.node }), Has(RecipeIndex));
  toQuery.push(HasValue(EntityType, { value: 'RECIPE' }));
  const results = runQuery(toQuery);
  return Array.from(results);
};
