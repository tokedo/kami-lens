/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/explorer/nodes/nodes.ts
 * changes:  none
 */

import { EntityIndex, getEntitiesWithValue, World } from 'engine/recs';

import { Components } from 'network/';
import { getAllNodes, getNode, getNodeByIndex } from 'network/shapes/Node';
import { getScavenges } from './stats';

export const nodes = (world: World, components: Components) => {
  const { EntityType } = components;
  return {
    all: () => {
      const nodes = getAllNodes(world, components);
      return nodes.sort((a, b) => a.index - b.index);
    },
    get: (entity: EntityIndex) => getNode(world, components, entity),
    getByIndex: (index: number) => getNodeByIndex(world, components, index),
    entities: () => Array.from(getEntitiesWithValue(EntityType, { value: 'NODE' })),
    indices: () => Array.from(components.NodeIndex.values.value.values()),
    stats: {
      getScavenges: (index: number, limit = 200, flatten = false) => {
        return getScavenges(world, components, index, limit, flatten);
      },
    },
  };
};
