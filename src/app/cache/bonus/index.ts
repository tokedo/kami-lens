/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
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
