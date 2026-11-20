/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/engine/encoders/index.ts
 * changes:  none
 */

export { createDecode, createDecoder } from './decode';
export { createEncoder } from './encode';

export type { Decode } from './decode';
