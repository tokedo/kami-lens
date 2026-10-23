/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/shapes/Goals/index.ts
 * changes:  none
 */

export { canClaim, canContribute } from './functions';
export { getAllGoals, getContributionByHash, getContributions, getGoalByIndex } from './getters';
export { getGoal } from './types';

export type { Contribution, Goal, Tier } from './types';
