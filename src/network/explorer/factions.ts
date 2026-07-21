/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/explorer/factions.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { getAllFactions, getFaction, getFactionByIndex } from 'network/shapes/Faction';

export const factions = (world: World, components: Components) => {
  return {
    all: () => getAllFactions(world, components),
    get: (entity: EntityIndex) => getFaction(world, components, entity),
    getByIndex: (index: number) => getFactionByIndex(world, components, index),
    indices: () => Array.from(components.FactionIndex.values.value.values()),
  };
};
