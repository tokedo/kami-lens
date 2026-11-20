/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/app/cache/trait/index.ts
 * changes:  none
 */

export { get as getTrait, process as processTrait } from './base';
export {
  compareAffinity as compareTraitAffinity,
  compareName as compareTraitName,
  compareRarity as compareTraitRarity,
} from './functions';
