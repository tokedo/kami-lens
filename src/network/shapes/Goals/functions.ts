/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Goals/functions.ts
 * changes:  one @ts-expect-error — upstream type defect at the pin (vite
 *           never typechecks): canClaim reads `contribution.score`, a field
 *           neither Contribution nor Score declares; `undefined == 0` is
 *           false, so the zero-contribution guard never fires upstream
 *           either — parity preserved. Body otherwise verbatim.
 */

import { World } from 'engine/recs';

import { Components } from 'network/';
import { Account } from '../Account';
import { passesConditions } from '../Conditional';
import { Contribution, Goal } from './types';

export const canContribute = (
  world: World,
  components: Components,
  goal: Goal,
  account: Account
): [boolean, string] => {
  if (goal.complete) return [false, 'Goal already completed'];

  if (!passesConditions(world, components, goal.requirements, account))
    return [false, 'Requirements not met'];

  return [true, ''];
};

export const canClaim = (goal: Goal, contribution: Contribution | undefined): [boolean, string] => {
  if (!goal.complete) return [false, 'Goal still in progress (be patient!)'];

  // @ts-expect-error upstream defect at the pin: `score` undeclared on Contribution
  if (!contribution || contribution.score == 0)
    return [false, 'You did not contribute - stop slacking and lock in, loser.'];
  else if (contribution.claimed) return [false, 'Already claimed!'];

  return [true, ''];
};
