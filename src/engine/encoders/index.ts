/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/engine/encoders/index.ts
 * changes:  none
 */

export { createDecode, createDecoder } from './decode';
export { createEncoder } from './encode';

export type { Decode } from './decode';
