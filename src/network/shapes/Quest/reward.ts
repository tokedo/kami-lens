/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/shapes/Quest/reward.ts
 * changes:  none
 */

import { EntityID, World } from 'engine/recs';

import { Components } from 'network/';
import { Allo, getAllosOf } from '../Allo';
import { hashArgs } from '../utils';

// Get the Entity Indices of the Rewards of a Quest
export const getRewards = (world: World, components: Components, questIndex: number): Allo[] => {
  let results = getAllosOf(world, components, genAlloAnchorID(questIndex));
  // sort rewards so reputation are always first
  results.sort((x, y) => {
    if (x.type === 'REPUTATION') return -1;
    if (y.type === 'REPUTATION') return 1;
    return 0;
  });
  return results;
};

const genAlloAnchorID = (questIndex: number): EntityID => {
  return hashArgs(['registry.quest.reward', questIndex], ['string', 'uint32']);
};
