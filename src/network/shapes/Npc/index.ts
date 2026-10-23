/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/shapes/Npc/index.ts
 * changes:  none
 */

export { NullNPC } from './constants';
export { getAll as getAllNPCs, getByIndex as getNPCByIndex } from './getters';
export { getListings as getNPCListings } from './listings';
export { queryByIndex as queryNPCByIndex, query as queryNPCs } from './queries';
export { get as getNPC } from './types';

export type { NPC } from './types';
