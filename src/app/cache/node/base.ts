/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/app/cache/node/base.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { Node, NullNode, getNode, queryNodeByIndex } from 'network/shapes/Node';
import { getStoredMultiplier } from 'network/shapes/Node/multiplier';
import { getHarvestMultiplier } from 'network/shapes/utils/component';

// nodes shouldnt change all that much while live
export const NodeCache = new Map<EntityIndex, Node>(); // node entity -> node

// get a node from its EntityIndex. the multiplier can change at any time, so it is re-read on every
// call; a change replaces the cached node, so callers comparing references see it
export const get = (world: World, components: Components, entity: EntityIndex) => {
  if (!NodeCache.has(entity)) process(world, components, entity);
  const node = NodeCache.get(entity)!;
  if (node === NullNode) return node;
  const multiplier = getStoredMultiplier(getHarvestMultiplier(components, entity));
  if (multiplier === node.multiplier) return node;
  const fresh = { ...node, multiplier };
  NodeCache.set(entity, fresh);
  return fresh;
};

// retrieve a node's most recent data and update it on the cache
export const process = (world: World, components: Components, entity: EntityIndex) => {
  const node = getNode(world, components, entity);
  NodeCache.set(entity, node);
  return node;
};

export const getByIndex = (world: World, components: Components, index: number) => {
  const entity = queryNodeByIndex(world, index);
  if (!entity) return NullNode;
  return get(world, components, entity);
};
