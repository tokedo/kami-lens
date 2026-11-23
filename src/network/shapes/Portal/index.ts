/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Portal/index.ts
 * changes:  none
 */

export { query as queryReceipts, queryByAccount as queryReceiptsByAccount } from './queries';
export { getReceipt } from './types';

export type { Receipt } from './types';
