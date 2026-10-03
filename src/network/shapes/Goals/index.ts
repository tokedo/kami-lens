/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/network/shapes/Goals/index.ts
 * changes:  none
 */

export { canClaim, canContribute } from './functions';
export { getAllGoals, getContributionByHash, getContributions, getGoalByIndex } from './getters';
export { getGoal } from './types';

export type { Contribution, Goal, Tier } from './types';
