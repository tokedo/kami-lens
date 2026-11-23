/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Harvest/node.ts
 * changes:  none
 */

import { EntityIndex, World, getComponentValue } from 'engine/recs';

import { formatEntityID } from 'engine/utils';
import { Components } from 'network/';
import { getNode as getNodeShape } from '../Node';
import { getStoredMultiplier, hasStoredCopy } from '../Node/multiplier';
import { getHarvestMultiplier as getRawMultiplier } from '../utils/component';

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

// the K this harvest's open stretch pays: the node's K copied when it opened, or the node's current
// K for a harvest from before K (no copy), as LibHarvest.getCopy reads it
export const getMultiplier = (
  world: World,
  components: Components,
  entity: EntityIndex
): number => {
  const raw = getRawMultiplier(components, entity);
  if (hasStoredCopy(raw)) return getStoredMultiplier(raw);
  const nodeEntity = queryNode(world, components, entity);
  return nodeEntity ? getStoredMultiplier(getRawMultiplier(components, nodeEntity)) : 0;
};

