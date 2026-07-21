/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Inventory/index.ts
 * changes:  none
 */

export { getByHolderItem as getInventoryByHolderItem } from './getters';
export { query as queryInventories, queryInstance as queryInventoryInstance } from './queries';
export { getInventory } from './types';

export type { Inventory } from './types';
