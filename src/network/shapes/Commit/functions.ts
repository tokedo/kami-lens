/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/shapes/Commit/functions.ts
 * changes:  none
 */

import { Commit } from './types';

export const filterRevealable = <T extends Commit>(commits: T[]): T[] => {
  return commits.filter((commit) => canReveal(commit));
};

// indefinite blockhash availability from block 979550 onwards
export const canReveal = (commit: Commit): boolean => {
  return commit.revealBlock > 0;
};
