/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Pool/queries.ts
 * changes:  none
 */

import { EntityIndex, HasValue, runQuery } from 'engine/recs';

import { Components } from 'network/components';

// get all Pool entities
export const query = (comps: Components): EntityIndex[] => {
  const { EntityType } = comps;
  return Array.from(runQuery([HasValue(EntityType, { value: 'POOL' })]));
};
