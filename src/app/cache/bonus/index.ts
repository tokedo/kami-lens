/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
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
