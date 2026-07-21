/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
