/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/network/shapes/Inventory/index.ts
 * changes:  none
 */

export { getByHolderItem as getInventoryByHolderItem } from './getters';
export { query as queryInventories, queryInstance as queryInventoryInstance } from './queries';
export { getInventory } from './types';

export type { Inventory } from './types';
