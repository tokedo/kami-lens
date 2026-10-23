// kami-lens partial port (not verbatim): upstream network/index.ts also
// exports createNetworkInstance/createNetworkLayer/updateNetworkLayer (the
// browser layer assembly bundling the burner-wallet signer and transaction
// executor; src/daemon.ts is the read-only replacement) and createNetworkConfig
// (browser env config, swap point 1). What ports here is the type surface the
// projection unit imports from 'network/': Components, and a structural
// NetworkLayer covering exactly the fields the ported shapes touch
// (world, components, network.connectedAddress). A headless daemon has no
// burner wallet, so connectedAddress.get() returns undefined and the
// burner-account getters degrade exactly as upstream does with no wallet
// connected (getFromBurner → NullAccount, queryFromEmbedded → entity 0).
// upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
// path:     packages/client/src/network/index.ts

import type { World } from 'engine/recs';

import type { Components } from './components';

export type { Components } from './components';

export type NetworkLayer = {
  world: World;
  components: Components;
  network: {
    connectedAddress: { get: () => string | undefined };
  };
};

export type Layers = { network: NetworkLayer }; // TODO: unpack this? (upstream comment preserved)
