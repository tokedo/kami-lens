/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/app/cache/account/index.ts
 * changes:  none
 */

export {
  AccountCache,
  get as getAccount,
  getByID as getAccountByID,
  process as processAccount,
} from './base';
export { calcCurrentStamina, calcIdleTime, calcStatPercent } from './calcs';
export { getAccessibleKamis, getAll as getAllAccounts, hasFood } from './functions';
export { getInventories as getAccountInventories, getKamis as getAccountKamis } from './getters';

export type { Account } from 'network/shapes/Account';
export type { Options as AccountOptions } from './base';
