/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Inventory/index.ts
 * changes:  none
 */

export { getByHolderItem as getInventoryByHolderItem } from './getters';
export { query as queryInventories, queryInstance as queryInventoryInstance } from './queries';
export { getInventory } from './types';

export type { Inventory } from './types';
