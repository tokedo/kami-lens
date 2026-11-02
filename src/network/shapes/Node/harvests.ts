/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/shapes/Node/harvests.ts
 * changes:  none
 */

import { EntityIndex, HasValue, World, runQuery } from 'engine/recs';

import { Components } from 'network/components';

// query a Node entity for all active harvest entities attached to it
export const queryHarvests = (world: World, comps: Components, entity: EntityIndex) => {
  const { EntityType, SourceID, State } = comps;
  const id = world.entities[entity];

  // get list of active harvests on this node
  return Array.from(
    runQuery([
      HasValue(SourceID, { value: id }), // most constraining field first
      HasValue(State, { value: 'ACTIVE' }),
      HasValue(EntityType, { value: 'HARVEST' }),
    ])
  );
};
