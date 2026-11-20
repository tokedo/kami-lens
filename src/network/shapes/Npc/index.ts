/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/network/shapes/Npc/index.ts
 * changes:  none
 */

export { NullNPC } from './constants';
export { getAll as getAllNPCs, getByIndex as getNPCByIndex } from './getters';
export { getListings as getNPCListings } from './listings';
export { queryByIndex as queryNPCByIndex, query as queryNPCs } from './queries';
export { get as getNPC } from './types';

export type { NPC } from './types';
