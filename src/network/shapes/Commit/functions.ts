/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
