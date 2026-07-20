/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/engine/providers/types.ts
 * changes:  none
 */

import { BrowserProvider, FetchRequest, JsonRpcProvider, Network, Networkish } from 'ethers';

import { create } from './create';

export enum ConnectionState {
  DISCONNECTED,
  CONNECTING,
  CONNECTED,
}

export type Providers = ReturnType<typeof create>;

export interface ProviderConfig {
  chainId: number;
  jsonRpcUrl: string;
  wsRpcUrl?: string;
  externalProvider?: BrowserProvider;
  options?: { batch?: boolean; pollingInterval?: number; skipNetworkCheck?: boolean };
}

export class MUDJsonRpcProvider extends JsonRpcProvider {
  constructor(url: string | FetchRequest | undefined, network: Networkish) {
    super(url, network);
  }
  async detectNetwork(): Promise<Network> {
    const network = this._network;
    if (network == null) {
      throw new Error('No network');
    }
    return network;
  }
}
