/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Commit/types.ts
 * changes:  none
 */

import { EntityID, EntityIndex, World, getComponentValue } from 'engine/recs';
import { formatEntityID } from 'engine/utils';
import { Components } from 'network/';

export interface Commit {
  id: EntityID;
  entity: EntityIndex;
  revealBlock: number;
  holder: EntityID;
  type: string;
}

export const get = (
  world: World,
  components: Components,
  entity: EntityIndex,
  holderID?: EntityID
): Commit => {
  const { HolderID, RevealBlock, Type } = components;

  return {
    id: world.entities[entity],
    entity,
    revealBlock: (getComponentValue(RevealBlock, entity)?.value as number) * 1,
    holder: holderID ?? formatEntityID(getComponentValue(HolderID, entity)?.value ?? ''),
    type: getComponentValue(Type, entity)?.value as string,
  };
};
