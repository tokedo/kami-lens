/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/app/cache/kills/index.ts
 * changes:  none
 */

export { get as getKill, process as processKill } from './base';

export type { KillLog } from 'network/shapes/Kill';
