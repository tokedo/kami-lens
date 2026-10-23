/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/app/cache/room/index.ts
 * changes:  none
 */

export { get as getRoom, getByIndex as getRoomByIndex } from './base';

export type { Room } from 'network/shapes/Room';
