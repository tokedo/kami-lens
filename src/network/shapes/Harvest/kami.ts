/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Harvest/kami.ts
 * changes:  none
 */

import { EntityIndex, getComponentValue, World } from 'engine/recs';
import { formatEntityID } from 'engine/utils';

import { Components } from 'network/components';
import { getKami as getKamiShape, KamiOptions } from '../Kami';

// gets the Kami entity of a Harvest entity
export const queryKami = (world: World, components: Components, entity: EntityIndex) => {
  const { HolderID } = components;
  const kamiID = formatEntityID(getComponentValue(HolderID, entity)?.value ?? '');
  return world.entityToIndex.get(kamiID)!;
};

// get the Kami object of a Harvest Entity
export const getKami = (
  world: World,
  components: Components,
  entity: EntityIndex,
  options?: KamiOptions
) => {
  const kamiEntity = queryKami(world, components, entity);
  if (!kamiEntity) return;
  return getKamiShape(world, components, kamiEntity, options);
};
