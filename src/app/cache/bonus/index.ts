/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/app/cache/bonus/index.ts
 * changes:  none
 */

export {
  getInstance as getBonusInstance,
  getRegistry as getBonusRegistry,
  process as processBonus,
} from './base';
export {
  getForEndType as getBonusesForEndType,
  getTemp as getTempBonuses,
  invalidateTempBonusesCache,
} from './getters';

export type { Bonus, BonusInstance } from 'network/shapes/Bonus';
