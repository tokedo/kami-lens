/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/app/cache/trait/functions.ts
 * changes:  none
 */

import { Trait } from 'network/shapes/Trait';

// compare the affinity of two traits for sorting
export const compareAffinity = (a: Trait, b: Trait) => {
  if (a.affinity! < b.affinity!) return -1;
  if (a.affinity! > b.affinity!) return 1;
  return 0;
};

// compare the names of two traits for sorting
export const compareName = (a: Trait, b: Trait) => {
  if (a.name! < b.name) return -1;
  if (a.name! > b.name!) return 1;
  return 0;
};

// compare the rarity of two traits for sorting
export const compareRarity = (a: Trait, b: Trait) => {
  if (a.rarity! < b.rarity!) return -1;
  if (a.rarity! > b.rarity!) return 1;

  return 0;
};
