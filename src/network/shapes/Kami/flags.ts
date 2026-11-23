/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Kami/flags.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/components';
import { hasFlag } from '../Flag';

export interface Flags {
  namable: boolean;
  skillReset: boolean;
}

// get the flags of a kami entity
export const getFlags = (world: World, components: Components, entity: EntityIndex): Flags => {
  return {
    namable: !hasFlag(world, components, entity, 'NOT_NAMEABLE'),
    skillReset: hasFlag(world, components, entity, 'CAN_RESET_SKILLS'),
  };
};
