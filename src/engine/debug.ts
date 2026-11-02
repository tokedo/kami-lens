/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/engine/debug.ts
 * changes:  none
 */

import createDebug from 'debug';

export const debug = createDebug('kami:network');
