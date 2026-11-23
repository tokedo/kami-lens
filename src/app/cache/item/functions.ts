/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/app/cache/item/functions.ts
 * changes:  none
 */

import { MUSU_INDEX } from 'constants/items';
import { Item } from 'network/shapes';

// very simple determination for now
export const isCurrency = (item: Item) => {
  return item.index === MUSU_INDEX;
};
