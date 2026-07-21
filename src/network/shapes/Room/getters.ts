/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Room/getters.ts
 * changes:  none
 */

import { World } from 'engine/recs';

import { Components } from 'network/';
import { QueryOptions, query } from './queries';
import { Room, RoomOptions, getRoom } from './types';

export const getRoomsX = (
  world: World,
  components: Components,
  options: QueryOptions,
  roomOptions?: RoomOptions
): Room[] => {
  const entities = query(components, options);
  return entities.map((entity) => {
    return getRoom(world, components, entity, roomOptions);
  });
};
