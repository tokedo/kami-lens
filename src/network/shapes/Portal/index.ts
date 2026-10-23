/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/shapes/Portal/index.ts
 * changes:  none
 */

export { query as queryReceipts, queryByAccount as queryReceiptsByAccount } from './queries';
export { getReceipt } from './types';

export type { Receipt } from './types';
