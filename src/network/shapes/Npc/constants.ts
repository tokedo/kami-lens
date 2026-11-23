/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Npc/constants.ts
 * changes:  none
 */

import { EntityID, EntityIndex } from 'engine/recs';

import { NPC } from './types';

export const NullNPC: NPC = {
  id: '0' as EntityID,
  index: 0,
  entity: 0 as EntityIndex,
  name: '',
  roomIndex: 0,
  listings: [],
};
