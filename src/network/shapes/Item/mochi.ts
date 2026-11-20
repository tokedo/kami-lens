/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/network/shapes/Item/mochi.ts
 * changes:  none
 */

import { EntityID, World } from 'engine/recs';

import { MOCHI_CAP_FALLBACK, MOCHI_INDICES } from 'constants/items';
import { Components } from 'network/components';
import { getData } from '../Data';
import { getByIndex } from './getters';

// mochi a kami has eaten over its lifetime, every mochi type counted
export const getMochiUsed = (world: World, components: Components, kamiID: EntityID): number => {
  return getData(world, components, kamiID, 'MOCHI_USED');
};

// the cap sits on the mochi registry as a CURR_MAX over mochi already eaten, so cap = value + 1
export const getMochiCap = (world: World, components: Components): number => {
  const mochi = getByIndex(world, components, MOCHI_INDICES[0]);
  const req = mochi.requirements.use.find((con) => con.target.type === 'MOCHI_USED');
  if (req?.target.value === undefined) return MOCHI_CAP_FALLBACK;
  return req.target.value * 1 + 1;
};
