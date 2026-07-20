/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/workers/debug.ts
 * changes:  none
 */

import { debug as parentDebug } from 'engine/debug';

export const debug = parentDebug.extend('workers');
