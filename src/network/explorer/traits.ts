/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/explorer/traits.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { getRegistryTraits, getTrait, getTraitByIndex } from 'network/shapes/Trait';

export const traits = (world: World, components: Components) => {
  return {
    all: () => getRegistryTraits(world, components),
    get: (entity: EntityIndex) => getTrait(world, components, entity),
    getByIndex: (type: string, index: number) => getTraitByIndex(world, components, index, type),
    indices: () => [
      ...new Set([
        ...Array.from(components.BackgroundIndex.values.value.values()),
        ...Array.from(components.BodyIndex.values.value.values()),
        ...Array.from(components.ColorIndex.values.value.values()),
        ...Array.from(components.FaceIndex.values.value.values()),
        ...Array.from(components.HandIndex.values.value.values()),
      ]),
    ],
  };
};
