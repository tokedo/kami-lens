/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
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
