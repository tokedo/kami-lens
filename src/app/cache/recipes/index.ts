/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/app/cache/recipes/index.ts
 * changes:  none
 */

export { getAll as getAllRecipes, get as getRecipe, process as processRecipe } from './base';

export type { Recipe } from 'network/shapes/Recipe';
