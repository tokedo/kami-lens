/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
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
