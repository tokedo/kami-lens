/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/explorer/goals.ts
 * changes:  one @ts-expect-error — upstream defect at the pin (vite never
 *           typechecks): `contributions` calls getContributions with three
 *           args against a two-arg (comps, goalID) signature, so every
 *           argument misaligns (comps receives the World) and the call
 *           throws upstream exactly as it would here — dead code behind an
 *           unchecked build, like the IsKill queries. Body otherwise
 *           verbatim.
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { getAllGoals, getContributions, getGoal, getGoalByIndex } from 'network/shapes/Goals';

export const goals = (world: World, components: Components) => {
  return {
    all: () => getAllGoals(world, components),
    get: (entity: EntityIndex) => getGoal(world, components, entity),
    getByIndex: (index: number) => getGoalByIndex(world, components, index),
    contributions: (goalIndex: number) =>
      // @ts-expect-error upstream defect at the pin: three args into (comps, goalID)
      getContributions(world, components, getGoalByIndex(world, components, goalIndex).id),
  };
};
