/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/app/cache/node/index.ts
 * changes:  none
 */

export { get as getNode, getByIndex as getNodeByIndex, process as processNode } from './base';

export type { Node } from 'network/shapes/Node';
