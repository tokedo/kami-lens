/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/app/cache/item/functions.ts
 * changes:  none
 */

import { MUSU_INDEX } from 'constants/items';
import { Item } from 'network/shapes';

// very simple determination for now
export const isCurrency = (item: Item) => {
  return item.index === MUSU_INDEX;
};
