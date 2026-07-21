/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
