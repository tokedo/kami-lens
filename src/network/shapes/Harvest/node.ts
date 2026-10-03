/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/network/shapes/Harvest/node.ts
 * changes:  none
 */

import { EntityIndex, World, getComponentValue } from 'engine/recs';

import { formatEntityID } from 'engine/utils';
import { Components } from 'network/';
import { getNode as getNodeShape } from '../Node';

// query the Node entity for a Harvest entity (field pull)
export const queryNode = (world: World, components: Components, entity: EntityIndex) => {
  const { SourceID } = components;
  const nodeID = formatEntityID(getComponentValue(SourceID, entity)?.value ?? '');
  return world.entityToIndex.get(nodeID);
};

// get the Node object of a Harvest entity
export const getNode = (world: World, components: Components, entity: EntityIndex) => {
  const nodeEntity = queryNode(world, components, entity);
  return getNodeShape(world, components, nodeEntity!);
};
