/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/network/shapes/Portal/index.ts
 * changes:  none
 */

export { query as queryReceipts, queryByAccount as queryReceiptsByAccount } from './queries';
export { getReceipt } from './types';

export type { Receipt } from './types';
