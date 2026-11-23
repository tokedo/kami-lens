/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Room/index.ts
 * changes:  none
 */

export { NullRoom } from './constants';
export { getExitsFor as getExitsForRoom } from './exit';
export { canEnterRoom, getAllRooms, getRoomByIndex, getRoomIndexByName } from './functions';
export { filterGates, getGates } from './gate';
export { getRoomsX } from './getters';
export { calculatePathStaminaCost, findPath } from './path';
export { queryByIndex as queryRoomByIndex, query as queryRooms } from './queries';
export { getRoom } from './types';

export type { Exit } from './exit';
export type { PathResult } from './path';
export type { QueryOptions } from './queries';
export type { Gate, Room, RoomOptions } from './types';
export type { Coord } from './utils';
