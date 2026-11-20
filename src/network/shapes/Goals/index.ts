/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/network/shapes/Goals/index.ts
 * changes:  none
 */

export { canClaim, canContribute } from './functions';
export { getAllGoals, getContributionByHash, getContributions, getGoalByIndex } from './getters';
export { getGoal } from './types';

export type { Contribution, Goal, Tier } from './types';
