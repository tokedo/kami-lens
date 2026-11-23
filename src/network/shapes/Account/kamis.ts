/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Account/kamis.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/components';
import { getKami, KamiOptions } from '../Kami';
import { query } from '../Kami/queries';

// query for all Kami entities owned by an Account entity
export const queryKamis = (world: World, components: Components, entity: EntityIndex) => {
  const id = world.entities[entity];
  return query(components, { account: id });
};

export const getKamis = (
  world: World,
  components: Components,
  entity: EntityIndex,
  options?: KamiOptions
) => {
  const kamiEntities = queryKamis(world, components, entity);
  return kamiEntities.map((kEntity) => getKami(world, components, kEntity, options));
};
