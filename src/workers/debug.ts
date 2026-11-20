/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/workers/debug.ts
 * changes:  none
 */

import { debug as parentDebug } from 'engine/debug';

export const debug = parentDebug.extend('workers');
