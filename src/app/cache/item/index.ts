/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/app/cache/item/index.ts
 * changes:  none
 */

export {
  getAll as getAllItems,
  get as getItem,
  getByIndex as getItemByIndex,
  initialize as initializeItems,
  process as processItem,
} from './base';
export { isCurrency as isItemCurrency } from './functions';

export type { Item } from 'network/shapes/Item';
