/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/network/shapes/Scavenge/types.ts
 * changes:  none
 */

import { EntityID, EntityIndex, World } from 'engine/recs';
import { Components } from 'network/';
import { Allo, getAllo } from '../Allo';
import { queryChildrenOf } from '../utils';
import { getAffinity, getIndex, getType, getValue } from '../utils/component';
import { queryRewardAnchor } from './queries';

export interface ScavBar {
  id: EntityID;
  entity: EntityIndex;
  type: string;
  index: number;
  affinity: string;
  cost: number;
  rewards: Allo[];
}

export const get = (
  world: World,
  components: Components,
  entity: EntityIndex,
  type?: string,
  index?: number
): ScavBar => {
  const id = world.entities[entity];
  const rewardAnchor = queryRewardAnchor(id);
  const rewardEntities = queryChildrenOf(components, rewardAnchor);

  return {
    id,
    entity,
    type: type ?? getType(components, entity),
    index: index ?? getIndex(components, entity),
    affinity: getAffinity(components, entity),
    cost: getValue(components, entity),
    rewards: rewardEntities.map((entity: EntityIndex) => getAllo(world, components, entity)),
  };
};
