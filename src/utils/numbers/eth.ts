/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/utils/numbers/eth.ts
 * changes:  none
 */

import { formatUnits } from 'viem';

export const formatEthPriceLabel = (value: unknown, decimals: number = 6) => {
  if (value === undefined || value === null) return '—';
  try {
    const wei = BigInt(value.toString());
    if (wei === 0n) return '0';
    const num = Number(formatUnits(wei, 18));
    if (num > 0 && num < 0.00001) return '<0.00001';
    return num.toFixed(decimals).replace(/\.?0+$/, '');
  } catch {
    return '—';
  }
};
