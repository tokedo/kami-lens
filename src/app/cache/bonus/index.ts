/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
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
