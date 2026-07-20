/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/engine/utils.ts
 * changes:  partial port (M0) — only the pure formatters. Upstream's
 *           messagePayload and fetchBlock (network-touching) land with M1
 *           (sync core).
 */

import { EntityID } from 'engine/recs';

// Remove zero padding from all entity ids
// Q(jb): do we even want to do this?  standardization seems preferable
// ethers utils keccak256 function maintains zero padding
export function formatEntityID(entityID: string | EntityID | bigint): EntityID {
  return ('0x' + BigInt(entityID).toString(16)) as EntityID;
}

// Enforce zero padding from all component ids
export function formatComponentID(componentID: string | bigint): string {
  const unpadded = BigInt(componentID).toString(16);
  const padded = unpadded.length % 2 === 0 ? unpadded : '0' + unpadded;
  return '0x' + padded;
}
