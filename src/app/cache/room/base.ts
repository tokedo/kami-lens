/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/app/cache/room/base.ts
 * changes:  Date.now() → clock.monotonicMs() at 2 call sites plus the
 *           clock import. The value only ever stamps and ages CACHE
 *           FRESHNESS, so it is read from a clock that cannot go backwards
 *           (1.0.0, A1 — src/clock.ts monotonicMs). 0.2–0.6 read the
 *           offset-corrected projection clock here, which steps backwards on
 *           a re-anchor and then skipped every forced refresh until it caught
 *           up again. Body otherwise verbatim.
 */

import * as clock from 'clock';
import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { getRoom, NullRoom, queryRoomByIndex, Room } from 'network/shapes/Room';
import { getExitsFor } from 'network/shapes/Room/exit';

export const RoomCache = new Map<EntityIndex, Room>();
export const ExitUpdateTs = new Map<EntityIndex, number>();

interface Options {
  exits?: number;
}

export const get = (
  world: World,
  components: Components,
  entity: EntityIndex,
  options?: Options
): Room => {
  if (!RoomCache.has(entity)) process(world, components, entity);
  const room = RoomCache.get(entity) ?? NullRoom;
  if (room.index == 0 || !options) return room;

  // populate the exits as requested
  if (options?.exits) {
    const updateTs = ExitUpdateTs.get(entity) ?? 0;
    const updateDelta = (clock.monotonicMs() - updateTs) / 1000; // convert to seconds
    if (updateDelta > options.exits) {
      room.exits = getExitsFor(world, components, room);
      ExitUpdateTs.set(entity, clock.monotonicMs());
    }
  }

  return room;
};

// process a base room entity into the cache
// TODO: add some logging here to ensure we warn when it's not a room entity
export const process = (world: World, components: Components, entity: EntityIndex) => {
  const room = getRoom(world, components, entity);
  if (room.index != 0) RoomCache.set(entity, room);
  return room;
};

// get a room through the caching layer by its index
export const getByIndex = (
  world: World,
  components: Components,
  index: number,
  options?: Options
): Room => {
  const entity = queryRoomByIndex(components, index);
  if (!entity) return NullRoom;
  return get(world, components, entity, options);
};
