/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/app/cache/config/index.ts
 * changes:  none
 */

export {
  getAddress as getConfigAddress,
  getArray as getConfigArray,
  getValue as getConfigValue,
  processAddress as processConfigAddress,
  processArray as processConfigArray,
  processValue as processConfigValue,
} from './base';
export { getMintConfig as getGachaMintConfig } from './gacha';
export {
  getConfig as getKamiConfig,
  isFalsey as isKamiConfigFalsey,
  processConfig as processKamiConfig,
} from './kami';
export { getConfig as getPortalConfig } from './portal';

export type { GachaMintConfig } from './gacha';
export type { Configs as PortalConfigs } from './portal';
