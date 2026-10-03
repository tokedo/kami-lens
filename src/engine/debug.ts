/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/engine/debug.ts
 * changes:  none
 */

import createDebug from 'debug';

export const debug = createDebug('kami:network');
