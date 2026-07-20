/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/utils/numbers/hex.ts
 * changes:  none
 */

import { BigNumberish } from 'ethers';

// convert a BigNumberish into a hex string
export const numberToHex = (n: BigNumberish) => {
  const raw = BigInt(n).toString(16);
  return (raw.length % 2 !== 0 ? '0x0' : '0x') + raw;
};

// convert an array of bytes (as uint8) into a padded hex string
export const uint8ArrayToHexString = (data: Uint8Array): string => {
  if (data.length === 0) return '0x00';
  let hex = data.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '');
  if (hex.substring(0, 2) == '0x') hex = hex.substring(2);
  const prefix = hex.length % 2 !== 0 ? '0x0' : '0x';
  return prefix + hex;
};
