/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/engine/encoders/index.ts
 * changes:  none
 */

export { createDecode, createDecoder } from './decode';
export { createEncoder } from './encode';

export type { Decode } from './decode';
