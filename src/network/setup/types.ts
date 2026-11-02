/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/setup/types.ts
 * changes:  none
 */

import { Component, Components, EntityIndex, Schema, Type } from 'engine/recs';
import { Contract } from 'ethers';

import { NetworkConfig } from 'engine/types';
import { NetworkComponentUpdate, SyncWorkerConfig, SystemCall } from 'workers/types';

export type SetupContractConfig = NetworkConfig &
  Omit<SyncWorkerConfig, 'worldContract' | 'mappings'> & {
    worldAddress: string;
    devMode?: boolean;
  };

export type DecodedNetworkComponentUpdate = Omit<
  Omit<NetworkComponentUpdate, 'entity'>,
  'component'
> & {
  entity: EntityIndex;
  component: Component<Schema>;
};

export type DecodedSystemCall<
  T extends { [key: string]: Contract } = { [key: string]: Contract },
  C extends Components = Components,
> = Omit<SystemCall<C>, 'updates'> & {
  systemId: keyof T;
  args: Record<string, unknown>;
  updates: DecodedNetworkComponentUpdate[];
};

export type ContractComponent = Component<Schema, { contractId: string }>;

export type ContractComponents = {
  [key: string]: ContractComponent;
};

export type NetworkComponents<C extends ContractComponents> = C & {
  SystemsRegistry: Component<{ value: Type.String }>;
  ComponentsRegistry: Component<{ value: Type.String }>;
  LoadingState: Component<{
    state: Type.Number;
    msg: Type.String;
    percentage: Type.Number;
  }>;
};
