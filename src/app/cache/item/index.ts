/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
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
