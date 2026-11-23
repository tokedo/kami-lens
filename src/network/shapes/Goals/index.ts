/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Goals/index.ts
 * changes:  none
 */

export { canClaim, canContribute } from './functions';
export { getAllGoals, getContributionByHash, getContributions, getGoalByIndex } from './getters';
export { getGoal } from './types';

export type { Contribution, Goal, Tier } from './types';
