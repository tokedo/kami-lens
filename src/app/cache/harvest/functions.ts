/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/app/cache/harvest/functions.ts
 * changes:  none
 */

import { Harvest } from 'network/shapes/Harvest';
import { NullItem } from 'network/shapes/Item';

// get the item being harvested from a harvest. assume node is populated
export const getItem = (harvest: Harvest) => {
  return harvest.node?.drops[0] ?? NullItem;
};
