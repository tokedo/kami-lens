/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/explorer/rooms.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { getAccount, queryRoomAccounts } from 'network/shapes/Account';
import { getAllRooms, getRoom, getRoomByIndex } from 'network/shapes/Room';

export const rooms = (world: World, components: Components) => {
  return {
    all: () => getAllRooms(world, components),
    get: (entity: EntityIndex) => getRoom(world, components, entity),
    getByIndex: (index: number) => getRoomByIndex(world, components, index),
    getPlayers: (index: number) =>
      queryRoomAccounts(components, index).map((entity) => getAccount(world, components, entity)),
    indices: () => Array.from(components.RoomIndex.values.value.values()),
  };
};
