/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/engine/encoders/index.ts
 * changes:  none
 */

export { createDecode, createDecoder } from './decode';
export { createEncoder } from './encode';

export type { Decode } from './decode';
