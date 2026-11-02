/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
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
