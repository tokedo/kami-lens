/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
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
