/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/network/setup/index.ts
 * changes:  partial port — upstream also exports createConfig (browser env
 *           config, swap point 1) and setupMUDNetwork (bundles the
 *           transaction executor; the read-only daemon assembly in
 *           src/daemon.ts replaces it). Type and utils lines are verbatim.
 */

export type {
  ContractComponent,
  ContractComponents,
  DecodedNetworkComponentUpdate,
  DecodedSystemCall,
  NetworkComponents,
  SetupContractConfig,
} from './types';
export * from './utils';
