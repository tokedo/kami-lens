/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
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
