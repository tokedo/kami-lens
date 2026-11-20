/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
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
