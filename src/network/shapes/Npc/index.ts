/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/shapes/Npc/index.ts
 * changes:  none
 */

export { NullNPC } from './constants';
export { getAll as getAllNPCs, getByIndex as getNPCByIndex } from './getters';
export { getListings as getNPCListings } from './listings';
export { queryByIndex as queryNPCByIndex, query as queryNPCs } from './queries';
export { get as getNPC } from './types';

export type { NPC } from './types';
