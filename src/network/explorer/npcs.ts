/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/explorer/npcs.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { getAllNPCs, getNPC, getNPCByIndex } from 'network/shapes/Npc';

export const npcs = (world: World, components: Components) => {
  return {
    all: () => getAllNPCs(world, components, { listings: true }),
    get: (entity: EntityIndex) => getNPC(world, components, entity, { listings: true }),
    getByIndex: (index: number) => getNPCByIndex(world, components, index, { listings: true }),
    indices: () => Array.from(components.NPCIndex.values.value.values()),
  };
};
