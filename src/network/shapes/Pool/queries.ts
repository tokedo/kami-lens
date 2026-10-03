/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
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
