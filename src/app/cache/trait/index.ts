/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/app/cache/trait/index.ts
 * changes:  none
 */

export { get as getTrait, process as processTrait } from './base';
export {
  compareAffinity as compareTraitAffinity,
  compareName as compareTraitName,
  compareRarity as compareTraitRarity,
} from './functions';
