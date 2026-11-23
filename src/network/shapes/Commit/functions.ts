/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
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
