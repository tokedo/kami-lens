/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
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
