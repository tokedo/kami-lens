/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/app/cache/trait/index.ts
 * changes:  none
 */

export { get as getTrait, process as processTrait } from './base';
export {
  compareAffinity as compareTraitAffinity,
  compareName as compareTraitName,
  compareRarity as compareTraitRarity,
} from './functions';
