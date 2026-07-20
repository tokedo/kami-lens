/**
 * kami-lens vendored dependency (MIT, compatible with this repo's AGPL-3.0).
 * package:   @mud-classic/utils@0.0.3 — the exact artifact the upstream client
 *            resolves (integrity matches upstream pnpm-lock.yaml at the pin).
 * source:    src/hash.ts, recovered from the published artifact's source maps.
 * copyright: (c) 2022-present Lattice Labs Ltd. (MIT License)
 * changes:   the artifact builds on its own bundled ethers v5
 *            (`BigNumber.from(keccak256(toUtf8Bytes(data))).toHexString()`);
 *            this repo uses ethers v6, so the body is re-expressed with the
 *            identical output semantics: minimal-length hex, zero-padded to
 *            whole bytes (even digit count). Equivalence is pinned by a unit
 *            test against formatEntityID/formatComponentID + ethers.id.
 *            keccak256Coord (unused by the sync layer) is not vendored.
 */

import { id } from 'ethers';

/**
 * Compute keccak256 hash from given string and remove padding from the resulting hex string
 * @param data String to be hashed
 * @returns Hash of the given string as hex string without padding
 */
export function keccak256(data: string) {
  // ethers v5 BigNumber.toHexString(): minimal byte-aligned hex (even length)
  const hex = BigInt(id(data)).toString(16);
  return '0x' + (hex.length % 2 === 0 ? hex : '0' + hex);
}
