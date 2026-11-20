/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/network/shapes/Inventory/index.ts
 * changes:  none
 */

export { getByHolderItem as getInventoryByHolderItem } from './getters';
export { query as queryInventories, queryInstance as queryInventoryInstance } from './queries';
export { getInventory } from './types';

export type { Inventory } from './types';
