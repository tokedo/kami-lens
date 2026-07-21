/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Listing/queries.ts
 * changes:  none
 */

import { EntityIndex, HasValue, runQuery } from 'engine/recs';

import { Components } from 'network/components';

export interface QueryOptions {
  npcIndex?: number;
  itemIndex?: number;
}

export const query = (comps: Components, options?: QueryOptions) => {
  const { EntityType, ItemIndex, NPCIndex } = comps;
  const query = [];
  if (options?.npcIndex) query.push(HasValue(NPCIndex, { value: options.npcIndex }));
  if (options?.itemIndex) query.push(HasValue(ItemIndex, { value: options.npcIndex }));
  query.push(HasValue(EntityType, { value: 'LISTING' }));
  return Array.from(runQuery(query));
};

export const queryByNPC = (comps: Components, npcIndex: number): EntityIndex[] => {
  return query(comps, { npcIndex });
};

export const queryByItem = (comps: Components, itemIndex: number): EntityIndex[] => {
  return query(comps, { itemIndex });
};
