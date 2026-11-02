/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
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
