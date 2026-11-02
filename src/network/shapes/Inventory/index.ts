/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/shapes/Inventory/index.ts
 * changes:  none
 */

export { getByHolderItem as getInventoryByHolderItem } from './getters';
export { query as queryInventories, queryInstance as queryInventoryInstance } from './queries';
export { getInventory } from './types';

export type { Inventory } from './types';
