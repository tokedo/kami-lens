/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Commit/getters.ts
 * changes:  none
 */

import { EntityID, World } from 'engine/recs';

import { Components } from 'network/';
import { queryForHolder } from './queries';
import { Commit, get } from './types';

export const getForHolder = (
  world: World,
  components: Components,
  field: string,
  holderID: EntityID
): Commit[] => {
  const entities = queryForHolder(components, holderID, field);
  return entities.map((entity): Commit => get(world, components, entity, holderID));
};
