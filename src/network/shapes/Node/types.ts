/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/network/shapes/Node/types.ts
 * changes:  none
 */

import { EntityID, EntityIndex, World, getComponentValue } from 'engine/recs';

import { Components } from 'network/';
import { Bonus, getBonusesByParent } from '../Bonus';
import { Condition } from '../Conditional';
import { Item, getItemByIndex } from '../Item';
import { ScavBar, getScavenge, queryScavRegistry } from '../Scavenge';
import { DetailedEntity, hashArgs } from '../utils';
import { getHarvestMultiplier } from '../utils/component';
import { NullNode } from './constants';
import { getRequirements } from './getters';
import { getStoredMultiplier } from './multiplier';

export interface BaseNode extends DetailedEntity {
  ObjectType: 'NODE';
  id: EntityID;
  affinity: string[];
  index: number;
}

// standardized shape of a Node Entity
export interface Node extends BaseNode {
  type: string;
  roomIndex: number;
  drops: Item[];
  requirements: Condition[];
  multiplier: number; // harvest multiplier K, per mille, set at node creation
  scavenge?: ScavBar;
  bonuses?: Bonus[];
}

export const getBaseNode = (
  world: World,
  components: Components,
  entity: EntityIndex
): BaseNode => {
  const { Affinity, Name, NodeIndex } = components;

  const affinity = parseAffinity(getComponentValue(Affinity, entity)?.value as string);

  return {
    ObjectType: 'NODE',
    id: world.entities[entity],
    entity,
    affinity,
    index: getComponentValue(NodeIndex, entity)?.value as number,
    name: getComponentValue(Name, entity)?.value as string,
    image: '',
  };
};

// get a Node from its EntityIndex
export const getNode = (world: World, components: Components, entity: EntityIndex): Node => {
  const { Description, ItemIndex, RoomIndex, NodeIndex, Type } = components;
  const nodeIndex = getComponentValue(NodeIndex, entity)?.value as number;
  const scavEntity = queryScavRegistry(world, 'NODE', nodeIndex)!;
  if (!nodeIndex) {
    console.warn(`Index not found for Node Entity ${entity}`);
    return NullNode;
  }

  let node: Node = {
    ...getBaseNode(world, components, entity),
    type: getComponentValue(Type, entity)?.value as string,
    roomIndex: getComponentValue(RoomIndex, entity)?.value as number,
    description: getComponentValue(Description, entity)?.value as string,
    drops: [
      getItemByIndex(world, components, getComponentValue(ItemIndex, entity)?.value as number),
    ],
    requirements: getRequirements(world, components, nodeIndex),
    multiplier: getStoredMultiplier(getHarvestMultiplier(components, entity)),
    scavenge: scavEntity ? getScavenge(world, components, scavEntity) : undefined,
    bonuses: getBonusesByParent(world, components, getBonusAnchor(nodeIndex)),
  };

  return node;
};

/////////////////
// UTILS

const parseAffinity = (affinity: string): string[] => {
  return affinity.split('-');
};

////////////////
// IDs

export const getBonusAnchor = (nodeIndex: number): EntityID => {
  return hashArgs(['node.bonus', nodeIndex], ['string', 'uint32']);
};
