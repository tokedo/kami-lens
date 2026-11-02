/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/utils/numbers/balances.ts
 * changes:  none
 */

import { formatUnits } from 'viem';

export const parseTokenBalance = (balance: bigint = BigInt(0), decimals: number = 18) => {
  const formatted = formatUnits(balance, decimals);
  return Number(formatted);
};

// rounds to a certain number of decimals
export const round = (num: number, decimals: number) => {
  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
};
