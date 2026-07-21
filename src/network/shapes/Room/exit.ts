/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Room/exit.ts
 * changes:  none
 */

import { getComponentValue, World } from 'engine/recs';
import { Components } from 'network/components';
import { Condition } from '../Conditional';
import { getAdjacentRoomIndices } from './functions';
import { getGatesBetween } from './gate';
import { Room } from './types';

// TODO: unsure if we still want to use this pattern. seems unnecessary.
export interface Exit {
  fromIndex: number;
  toIndex: number;
  gates: Condition[];
  blocked?: boolean;
}

// get the exit between two rooms along with its gates
const getExit = (
  world: World,
  components: Components,
  toIndex: number,
  fromIndex: number
): Exit => {
  return {
    toIndex,
    fromIndex,
    gates: getGatesBetween(world, components, toIndex, fromIndex),
  };
};

// get the exits for a room
export const getExitsFor = (world: World, components: Components, room: Room): Exit[] => {
  const { Exits } = components;
  const specialExits = (getComponentValue(Exits, room.entity)?.value as number[]) || [];
  const adjExits = getAdjacentRoomIndices(components, room.location);
  const rawExits = [...specialExits, ...adjExits];
  return rawExits.map((toIndex) => getExit(world, components, toIndex, room.index));
};
