/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/app/cache/node/index.ts
 * changes:  none
 */

export { get as getNode, getByIndex as getNodeByIndex, process as processNode } from './base';

export type { Node } from 'network/shapes/Node';
