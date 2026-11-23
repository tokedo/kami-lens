/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Node/functions.ts
 * changes:  none
 */

import { World } from 'engine/recs';

import { Components } from 'network/';
import { passesConditions } from '../Conditional';
import { Kami } from '../Kami';
import { getRequirements } from './getters';

// account edited out as it's not used atm
export const passesRequirements = (
  world: World,
  components: Components,
  index: number, // nodeIndex
  // account: Account,
  kami: Kami
): boolean => {
  if (!index) return false;
  const requirements = getRequirements(world, components, index);
  return passesConditions(world, components, requirements, kami);
};
