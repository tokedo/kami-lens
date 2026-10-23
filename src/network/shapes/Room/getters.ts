/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
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
