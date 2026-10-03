/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/workers/debug.ts
 * changes:  none
 */

import { debug as parentDebug } from 'engine/debug';

export const debug = parentDebug.extend('workers');
