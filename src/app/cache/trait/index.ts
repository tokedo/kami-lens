/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/app/cache/trait/index.ts
 * changes:  none
 */

export { get as getTrait, process as processTrait } from './base';
export {
  compareAffinity as compareTraitAffinity,
  compareName as compareTraitName,
  compareRarity as compareTraitRarity,
} from './functions';
