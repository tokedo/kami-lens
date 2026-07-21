/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Goals/index.ts
 * changes:  none
 */

export { canClaim, canContribute } from './functions';
export { getAllGoals, getContributionByHash, getContributions, getGoalByIndex } from './getters';
export { getGoal } from './types';

export type { Contribution, Goal, Tier } from './types';
