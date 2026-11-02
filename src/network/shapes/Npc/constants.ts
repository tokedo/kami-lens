/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
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
