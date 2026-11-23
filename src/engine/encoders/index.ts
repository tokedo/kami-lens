/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/engine/encoders/index.ts
 * changes:  none
 */

export { createDecode, createDecoder } from './decode';
export { createEncoder } from './encode';

export type { Decode } from './decode';
