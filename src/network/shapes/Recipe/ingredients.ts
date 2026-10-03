/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/network/shapes/Recipe/ingredients.ts
 * changes:  none
 */

import { EntityIndex, World, getComponentValue } from 'engine/recs';
import { Item } from '../Item';

import { Components } from 'network/';

export interface Ingredient {
  item?: Item; // this is populated by the cache
  index: number;
  amount: number;
}

export const getIngredients = (
  world: World,
  components: Components,
  entity: EntityIndex | undefined
): Ingredient[] => {
  if (!entity) return [];

  const { Keys, Values } = components;
  const keys = getComponentValue(Keys, entity)?.value as number[] | [];
  const values = getComponentValue(Values, entity)?.value as number[] | [];

  return keys.map((itemIndex, i) => getIngredient(itemIndex, values[i] * 1));
};

const getIngredient = (itemIndex: number, amount: number): Ingredient => {
  return {
    index: itemIndex,
    amount: amount,
  };
};
