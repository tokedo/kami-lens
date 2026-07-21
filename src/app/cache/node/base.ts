/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/app/cache/node/base.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { Node, NullNode, getNode, queryNodeByIndex } from 'network/shapes/Node';

// nodes shouldnt change all that much while live
export const NodeCache = new Map<EntityIndex, Node>(); // node entity -> node

// get a node from its EntityIndex
export const get = (world: World, components: Components, entity: EntityIndex) => {
  if (!NodeCache.has(entity)) process(world, components, entity);
  return NodeCache.get(entity)!;
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
