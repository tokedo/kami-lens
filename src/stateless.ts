// kami-lens native module (not a port): the stateless degraded mode
// (DESIGN §4.3, gate G3.d) — single-kami vitals with NO daemon and NO
// mirror, from deterministic on-chain reads alone:
//
//   1. World.systems() → the systems registry component;
//   2. registry.getEntitiesWithValue(abi.encode(keccak256("system.getter")))
//      → the GetterSystem address (deterministic system ID, verified against
//      packages/contracts/src/systems/GetterSystem.sol at the pin);
//   3. GetterSystem.getKamiByIndex(index) at a pinned block → KamiShape.
//
// The output is the stateless-computable SUBSET of the kami query: discrete
// vitals (identity, state, level, stat totals via the client's
// (1 + boost/1e3) × (base + shift) formula — network/shapes/Stats.ts).
// Continuous projections (current HP, accrued musu, cooldown countdown)
// require the mirror's time fields and are daemon-only; discovery queries
// in stateless mode exit with the documented 'requires daemon' code rather
// than a wrong answer.

import { Contract, JsonRpcProvider, keccak256, toUtf8Bytes, AbiCoder, Result } from 'ethers';

import { KamiLensConfig } from './config';

const WORLD_ABI = ['function systems() view returns (address)'];
const REGISTRY_ABI = [
  'function getEntitiesWithValue(bytes value) view returns (uint256[])',
];
const GETTER_ABI = [
  'function getKamiByIndex(uint32 index) view returns (tuple(uint256 id, uint32 index, string name, string mediaURI, tuple(tuple(int32 base, int32 shift, int32 boost, int32 sync) health, tuple(int32 base, int32 shift, int32 boost, int32 sync) power, tuple(int32 base, int32 shift, int32 boost, int32 sync) harmony, tuple(int32 base, int32 shift, int32 boost, int32 sync) violence) stats, tuple(uint32 face, uint32 hand, uint32 body, uint32 background, uint32 color) traits, string[] affinities, uint256 account, uint256 level, uint256 xp, uint32 room, string state))',
];

const GETTER_SYSTEM_ID = keccak256(toUtf8Bytes('system.getter'));

export type StatelessKami = {
  id: string;
  index: number;
  name: string;
  state: string;
  level: number;
  hp: { total: number };
  accountId: string;
  blockNumber: number;
};

const statTotal = (raw: unknown): number => {
  // ethers Result: take named fields via toObject() when available, else
  // positional (base, shift, boost, sync) per the Stat struct at the pin.
  const s =
    raw instanceof Result
      ? (raw.toObject() as { base: bigint; shift: bigint; boost: bigint })
      : (raw as { base: bigint; shift: bigint; boost: bigint });
  return (1 + Number(s.boost) / 1e3) * (Number(s.base) + Number(s.shift));
};

export async function statelessKami(
  config: KamiLensConfig,
  index: number,
  blockTag?: number
): Promise<StatelessKami> {
  const provider = new JsonRpcProvider(
    config.jsonRpcUrl,
    { chainId: config.chainId, name: 'yominet' },
    { staticNetwork: true }
  );
  try {
    const world = new Contract(config.worldAddress, WORLD_ABI, provider);
    const systemsRegistry: string = await world.systems({ blockTag });
    const registry = new Contract(systemsRegistry, REGISTRY_ABI, provider);
    const encoded = AbiCoder.defaultAbiCoder().encode(['uint256'], [GETTER_SYSTEM_ID]);
    const entities: bigint[] = await registry.getEntitiesWithValue(encoded, { blockTag });
    if (entities.length === 0) throw new Error('GetterSystem not found in the systems registry');
    const getterAddress = '0x' + entities[0].toString(16).padStart(40, '0');
    const getter = new Contract(getterAddress, GETTER_ABI, provider);
    const resolvedBlock = blockTag ?? (await provider.getBlockNumber());
    const shape = await getter.getKamiByIndex(index, { blockTag: resolvedBlock });
    return {
      id: '0x' + BigInt(shape.id).toString(16),
      index: Number(shape.index),
      name: shape.name,
      state: shape.state,
      level: Number(shape.level),
      hp: { total: statTotal(shape.stats.health) },
      accountId: '0x' + BigInt(shape.account).toString(16),
      blockNumber: resolvedBlock,
    };
  } finally {
    provider.destroy();
  }
}
