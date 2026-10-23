/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/engine/types.ts
 * changes:  none
 */

import { Components } from 'engine/recs';
import { Contract } from 'ethers';

import { ClockConfig } from './executors';
import { ProviderConfig } from './providers';

export type Contracts = {
  [key: string]: Contract;
};

// Mapping from hashed contract component id to client component key
export type Mappings<C extends Components> = {
  [hashedContractId: string]: keyof C;
};

export interface NetworkConfig {
  chainId: number;
  privateKey?: string;
  clock: ClockConfig;
  provider: ProviderConfig;
  snapshotServiceUrl?: string;
  streamServiceUrl?: string;
  initialBlockNumber?: number;
  blockExplorer?: string;
  cache?: {
    interval?: number; // block interval of caching state updates
    expiry?: number; // number of blocks before cache is considered expired
  };
  encoders?: boolean;
  pruneOptions?: { playerAddress: string; hashedComponentId: string };
}
