// Gate G7.b [live] — 0.3.0 pool rows verified on-chain, the G6.b proof
// shape. Which pools exist is answerable only from the mirror (the
// entity-type component carries no on-chain reverse index — this gate
// records that fact by probing for it), but every element of every row it
// returns is chain-checkable one entity at a time by pinned eth_call reads
// at the mirror's own block, healed near-head first because the public RPC
// serves eth_call state only a shallow window deep.
//
//   · per served pool: the entity carries the POOL type on-chain; its
//     stored pair equals the served pair; the fee, the share supply and
//     the creation time equal the served numbers;
//   · per served pool: each reserve equals the balance held at the
//     deterministic inventory entity for (pool, item) — the reserve is an
//     ordinary inventory row belonging to the pool itself;
//   · negative sample: an item pair with no pool has no pool entity, so a
//     served-set omission would be visible;
//   · the entity-type reverse-lookup probe, recorded either way;
//   · PREDICTION 4 in its checkable form: a single answer, read once,
//     contains reserves and fee that are true at the block it names —
//     which is what "readable in the same session that would swap" means
//     operationally.
//
// The newbie-vendor display window rides along: its pool and cycle anchor
// are read off the vendor entity on-chain and compared to the served
// facts, so the window a consumer is told about is the window the world
// holds.

import { AbiCoder, Contract, solidityPackedKeccak256 } from 'ethers';
import path from 'node:path';

import { resolveConfig } from '../../src/config';
import { serveQuery } from '../../src/queries';
import { getCompAddr } from '../../src/network/shapes/utils/addresses';
import { queryInventoryInstance } from '../../src/network/shapes/Inventory';
import { EntityID } from '../../src/engine/recs';
import { formatEntityID } from '../../src/engine/utils';
import {
  ARTIFACTS_DIR,
  fail,
  loadCacheFromSnapshotFile,
  makeFetchWorldEvents,
  makeProvider,
  pass,
  replayOnto,
  sleep,
  writeMeasurement,
} from '../g1/lib.mts';
import { buildMirror } from '../g2/lib.mts';

const COMPONENT_ABI = [
  'function has(uint256 entity) view returns (bool)',
  'function getRaw(uint256 entity) view returns (bytes)',
];
const REVERSE_ABI = ['function getEntitiesWithValue(bytes value) view returns (uint256[])'];
const abi = AbiCoder.defaultAbiCoder();

const config = resolveConfig();
const cache = await loadCacheFromSnapshotFile(path.join(ARTIFACTS_DIR, 'c2.v8snap'), config);
{
  // two-stage heal, as G6.b: pay the long gap first, then re-pin with a
  // cheap delta replay so the target is inside the state window when the
  // first read lands
  const p = makeProvider(config);
  const coarse = (await p.getBlockNumber()) - 6;
  console.log(`[g7.b] coarse heal ${cache.blockNumber} → ${coarse}`);
  await replayOnto(cache, makeFetchWorldEvents(p, config), coarse);
  const target = (await p.getBlockNumber()) - 6;
  console.log(`[g7.b] delta re-pin ${cache.blockNumber} → ${target}`);
  await replayOnto(cache, makeFetchWorldEvents(p, config), target);
  p.destroy();
}
const { world, components } = buildMirror(cache);
const mirror = { world, components, blockNumber: cache.blockNumber };
const pinnedBlock = cache.blockNumber;

async function serve(query: string, args: string[]): Promise<unknown> {
  return (await serveQuery(mirror, query, args, { stale: false, mode: 'daemon' })).data;
}

const provider = makeProvider(config);
// getCompAddr serves the registry value unpadded; pad to a full 20-byte
// address before constructing contracts (the G6.b lesson)
const compAddr = (key: string): string =>
  '0x' + getCompAddr(world, components, key).slice(2).padStart(40, '0');
const contracts = {
  entityType: new Contract(compAddr('component.type.entity'), COMPONENT_ABI, provider),
  keys: new Contract(compAddr('component.keys'), COMPONENT_ABI, provider),
  rate: new Contract(compAddr('component.rate'), COMPONENT_ABI, provider),
  value: new Contract(compAddr('component.value'), COMPONENT_ABI, provider),
  startTime: new Contract(compAddr('component.Time.Start'), COMPONENT_ABI, provider),
  values: new Contract(compAddr('component.values'), COMPONENT_ABI, provider),
};

async function readRaw(contract: Contract, entityId: string | bigint): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const via = attempt === 0 ? provider : makeProvider(config);
    try {
      const c =
        attempt === 0 ? contract : new Contract(await contract.getAddress(), COMPONENT_ABI, via);
      const exists: boolean = await c.has(BigInt(entityId), { blockTag: pinnedBlock });
      if (!exists) return null;
      return await c.getRaw(BigInt(entityId), { blockTag: pinnedBlock });
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(300 * (attempt + 1));
    } finally {
      if (via !== provider) via.destroy();
    }
  }
  return null;
}

const violations: Record<string, unknown>[] = [];
const counts: Record<string, number> = {};
const note = (area: string, n = 1) => (counts[area] = (counts[area] ?? 0) + n);

type PoolOut = {
  id: string;
  items: number[];
  reserves: number[];
  feeBps: number;
  lpSupply: number;
  startTime: number;
};

// --- the served answer, read ONCE (prediction 4's "same session") -----------
const served = (await serve('items', [])) as { items: { index: number }[]; pools: PoolOut[] };
const servedAtBlock = pinnedBlock;

// --- per-pool chain verification --------------------------------------------
for (const pool of served.pools) {
  note('poolsVerified');

  const typeRaw = await readRaw(contracts.entityType, pool.id);
  if (typeRaw === null) {
    violations.push({ area: 'pool', pool: pool.id, reason: 'no entity-type row on-chain' });
    continue;
  }
  const type = abi.decode(['string'], typeRaw)[0] as string;
  if (type !== 'POOL') {
    violations.push({ area: 'pool', pool: pool.id, reason: 'entity is not a pool on-chain', chain: type });
  }

  const keysRaw = await readRaw(contracts.keys, pool.id);
  const keys = keysRaw === null ? null : (abi.decode(['uint256[]'], keysRaw)[0] as bigint[]);
  if (!keys || keys.length !== pool.items.length || keys.some((k, i) => Number(k) !== pool.items[i])) {
    violations.push({ area: 'pool', pool: pool.id, reason: 'pair differs', served: pool.items, chain: keys?.map(Number) ?? null });
  }

  const checks: [string, Contract, number][] = [
    ['feeBps', contracts.rate, pool.feeBps],
    ['lpSupply', contracts.value, pool.lpSupply],
    ['startTime', contracts.startTime, pool.startTime],
  ];
  for (const [field, contract, expect] of checks) {
    const raw = await readRaw(contract, pool.id);
    const chain = raw === null ? null : (abi.decode(['uint256'], raw)[0] as bigint);
    if (chain === null || Number(chain) !== expect) {
      violations.push({ area: 'pool', pool: pool.id, field, served: expect, chain: chain?.toString() ?? null });
    }
  }

  // reserves are inventory rows held by the pool entity itself
  for (let i = 0; i < pool.items.length; i++) {
    note('reservesVerified');
    const entity = queryInventoryInstance(world, pool.id as EntityID, pool.items[i]);
    const invId = entity !== undefined ? world.entities[entity] : undefined;
    if (!invId) {
      if (pool.reserves[i] !== 0) {
        violations.push({ area: 'reserve', pool: pool.id, item: pool.items[i], reason: 'no inventory entity for a nonzero reserve' });
      }
      continue;
    }
    const raw = await readRaw(contracts.value, invId);
    const chain = raw === null ? null : (abi.decode(['uint256'], raw)[0] as bigint);
    if (chain === null || Number(chain) !== pool.reserves[i]) {
      violations.push({ area: 'reserve', pool: pool.id, item: pool.items[i], served: pool.reserves[i], chain: chain?.toString() ?? null });
    }
  }
}

// --- negative samples: unpooled pairs must have no pool entity ---------------
// The pool entity id is a pure hash of the sorted pair, so a pair that is
// NOT served must be checkable for absence. This is what makes an omission
// from the served set visible rather than invisible.
{
  const servedPairs = new Set(served.pools.map((p) => p.items.join('-')));
  const indexes = served.items.map((i) => i.index).filter((i) => i > 0);
  const musu = indexes.includes(1) ? 1 : indexes[0];
  let negatives = 0;
  for (const other of indexes) {
    if (negatives >= 12) break;
    if (other === musu) continue;
    const [lo, hi] = musu < other ? [musu, other] : [other, musu];
    if (servedPairs.has(`${lo}-${hi}`)) continue;
    const id = formatEntityID(solidityPackedKeccak256(['string', 'uint32', 'uint32'], ['amm.pool', lo, hi]));
    const raw = await readRaw(contracts.entityType, id);
    negatives++;
    note('negativeSamples');
    if (raw !== null) {
      const type = abi.decode(['string'], raw)[0] as string;
      if (type === 'POOL') {
        violations.push({ area: 'negative', pair: [lo, hi], reason: 'a live pool is missing from the served set' });
      }
    }
  }
}

// --- the reverse-lookup probe, recorded either way --------------------------
let entityTypeReverseLookup: string;
try {
  const reverse = new Contract(compAddr('component.type.entity'), REVERSE_ABI, provider);
  const hits: bigint[] = await reverse.getEntitiesWithValue(abi.encode(['string'], ['POOL']), {
    blockTag: pinnedBlock,
  });
  entityTypeReverseLookup = `available (${hits.length} entities)`;
} catch (e) {
  entityTypeReverseLookup = `unavailable: ${String(e).slice(0, 120)}`;
}

// --- newbie vendor: the served window against the vendor entity --------------
type MerchantOut = {
  newbieVendor?: { displayedKamiIndices: number[]; poolSize: number; cycleStart: number };
};
const merchant = (await serve('merchant', [])) as MerchantOut;
const vendor = merchant.newbieVendor;
let vendorChainPoolSize: number | null = null;
if (vendor) {
  note('vendorVerified');
  const vendorId = formatEntityID(solidityPackedKeccak256(['string'], ['newbie.vendor']));
  const poolRaw = await readRaw(contracts.values, vendorId);
  const chainPool = poolRaw === null ? null : (abi.decode(['uint256[]'], poolRaw)[0] as bigint[]);
  vendorChainPoolSize = chainPool?.length ?? null;
  if (vendorChainPoolSize !== vendor.poolSize) {
    violations.push({ area: 'vendor', field: 'poolSize', served: vendor.poolSize, chain: vendorChainPoolSize });
  }
  const chainSet = new Set((chainPool ?? []).map(Number));
  for (const index of vendor.displayedKamiIndices) {
    if (!chainSet.has(index)) {
      violations.push({ area: 'vendor', reason: 'displayed kami is not in the on-chain pool', kami: index });
    }
  }
  const startRaw = await readRaw(contracts.startTime, vendorId);
  const chainStart = startRaw === null ? null : Number(abi.decode(['uint256'], startRaw)[0] as bigint);
  if (chainStart !== vendor.cycleStart) {
    violations.push({ area: 'vendor', field: 'cycleStart', served: vendor.cycleStart, chain: chainStart });
  }
}

const headAfter = await provider.getBlockNumber();
provider.destroy();

await writeMeasurement('g7b-chain-crosscheck', {
  pinnedBlock,
  servedAtBlock,
  headAfterVerify: headAfter,
  blocksBehindAtEnd: headAfter - pinnedBlock,
  poolsServed: served.pools.length,
  pools: served.pools.map((p) => ({ id: p.id, items: p.items, reserves: p.reserves, feeBps: p.feeBps })),
  entityTypeReverseLookup,
  newbieVendor: vendor ? { ...vendor, chainPoolSize: vendorChainPoolSize } : null,
  counts,
  violations: violations.slice(0, 20),
  violationCount: violations.length,
  match: violations.length === 0,
});

if (violations.length > 0) {
  fail('G7.b', {
    reason: 'chain mismatch on the 0.3.0 surface',
    violations: violations.slice(0, 10),
    violationCount: violations.length,
  });
}
if (!counts.poolsVerified) {
  fail('G7.b', { reason: 'no pool rows were served, so nothing was verified', counts });
}
pass('G7.b', { ...counts, entityTypeReverseLookup });
process.exit(0);
