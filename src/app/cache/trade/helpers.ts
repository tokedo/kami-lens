/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/app/cache/trade/helpers.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/components';
import { TradeOrder } from 'network/shapes/Trade/types';
import { getKeys, getValues } from 'network/shapes/utils/component';
import { getItemByIndex } from '../item';

export const getOrder = (
  world: World,
  comps: Components,
  entity: EntityIndex | undefined
): TradeOrder => {
  if (!entity) return { items: [], amounts: [] };

  const keys = getKeys(comps, entity);
  const values = getValues(comps, entity);

  return {
    items: keys.map((key) => getItemByIndex(world, comps, key)),
    amounts: values,
  };
};
