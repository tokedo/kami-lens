/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Portal/index.ts
 * changes:  none
 */

export { query as queryReceipts, queryByAccount as queryReceiptsByAccount } from './queries';
export { getReceipt } from './types';

export type { Receipt } from './types';
