// Gate G6.b [live] — 0.2.0 discovery answers verified on-chain. The same
// proof shape as G3.b: each served row only exists as an answer via the
// mirror, but every element is chain-checkable by direct pinned eth_call
// component reads at the mirror's own block (healed near-head first — the
// public RPC serves eth_call state only ~50–120 blocks deep, measured
// 2026-07-21).
//
//   · inventory: every row of a sampled account — the deterministic
//     inventory.instance hash (holderID × itemIndex) must exist on-chain
//     with component.value == the served balance;
//   · room: every served occupant reads component.index.room == the room;
//     negative samples from other rooms must not;
//   · merchant: every listing of every merchant reads component.value ==
//     value, component.balance == balance, component.index.item == the
//     item index;
//   · leaderboard: sampled rows (top 20 + every 100th — the sampling is
//     recorded, the row set is thousands) — the is.score hash entity for
//     (holder, epoch, index, type) reads component.value == the served
//     value.

import { AbiCoder, Contract } from 'ethers';
import path from 'node:path';

import { resolveConfig } from '../../src/config';
import { serveQuery } from '../../src/queries';
import { getCompAddr } from '../../src/network/shapes/utils/addresses';
import { queryInventoryInstance } from '../../src/network/shapes/Inventory';
import { query as queryKamis } from '../../src/network/shapes/Kami/queries';
import { getEntity as getScoreEntity } from '../../src/network/shapes/Score/utils';
import { getKamiIndex } from '../../src/network/shapes/utils/component';
import { EntityID } from '../../src/engine/recs';
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
const abi = AbiCoder.defaultAbiCoder();

const config = resolveConfig();
const cache = await loadCacheFromSnapshotFile(path.join(ARTIFACTS_DIR, 'c2.v8snap'), config);
{
  const p = makeProvider(config);
  const target = (await p.getBlockNumber()) - 8;
  console.log(`[g6.b] healing mirror ${cache.blockNumber} → ${target} for in-window reads`);
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
const contracts = {
  value: new Contract(getCompAddr(world, components, 'component.value'), COMPONENT_ABI, provider),
  balance: new Contract(getCompAddr(world, components, 'component.balance'), COMPONENT_ABI, provider),
  room: new Contract(getCompAddr(world, components, 'component.index.room'), COMPONENT_ABI, provider),
  item: new Contract(getCompAddr(world, components, 'component.index.item'), COMPONENT_ABI, provider),
};

async function readRaw(contract: Contract, entityId: string | bigint): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const via = attempt === 0 ? provider : makeProvider(config);
    try {
      const c = attempt === 0 ? contract : new Contract(await contract.getAddress(), COMPONENT_ABI, via);
      const exists: boolean = await c.has(BigInt(entityId), { blockTag: pinnedBlock });
      if (!exists) return null;
      return await c.getRaw(BigInt(entityId), { blockTag: pinnedBlock });
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(500 * (attempt + 1));
    } finally {
      if (via !== provider) via.destroy();
    }
  }
  return null;
}

const asUint = (raw: string | null): bigint | null => (raw === null ? null : (abi.decode(['uint256'], raw)[0] as bigint));

const violations: Record<string, unknown>[] = [];
const counts: Record<string, number> = {};
const note = (area: string, n = 1) => (counts[area] = (counts[area] ?? 0) + n);

// --- sample account (first kami owner) --------------------------------------
const kamiIndexes = queryKamis(components)
  .slice(0, 80)
  .map((e) => getKamiIndex(components, e))
  .filter((i) => i > 0);
let accountIndex = 0;
for (const idx of kamiIndexes) {
  const data = (await serve('kami', [String(idx)])) as { account?: { index: number } };
  if (data.account?.index) {
    accountIndex = data.account.index;
    break;
  }
}
if (!accountIndex) fail('G6.b', { reason: 'no sampled account' });

// --- inventory ---------------------------------------------------------------
const accountData = (await serve('account', [String(accountIndex)])) as { id: string; roomIndex: number };
const inventory = (await serve('inventory', [String(accountIndex)])) as {
  items: { balance: number; item: { index: number } }[];
};
for (const row of inventory.items) {
  note('inventoryRows');
  const entity = queryInventoryInstance(world, accountData.id as EntityID, row.item.index);
  const invId = entity !== undefined ? world.entities[entity] : undefined;
  if (!invId) {
    violations.push({ area: 'inventory', reason: 'no deterministic instance entity', item: row.item.index });
    continue;
  }
  const balance = asUint(await readRaw(contracts.value, invId));
  const itemIdx = asUint(await readRaw(contracts.item, invId));
  if (balance !== BigInt(row.balance) || itemIdx !== BigInt(row.item.index)) {
    violations.push({ area: 'inventory', item: row.item.index, served: row.balance, chain: balance?.toString(), chainItem: itemIdx?.toString() });
  }
}

// --- room --------------------------------------------------------------------
const room = (await serve('room', [String(accountData.roomIndex)])) as {
  index: number;
  accounts: { id: string; index: number }[];
};
for (const occupant of room.accounts) {
  note('roomOccupants');
  const roomIdx = asUint(await readRaw(contracts.room, occupant.id));
  if (roomIdx !== BigInt(room.index)) {
    violations.push({ area: 'room', account: occupant.index, served: room.index, chain: roomIdx?.toString() });
  }
}
// negative samples: accounts from a different room must not read as here
{
  let negatives = 0;
  for (let candidate = 1; candidate <= 120 && negatives < 5; candidate++) {
    if (candidate === room.index) continue;
    let other: { accounts: { id: string; index: number }[] };
    try {
      other = (await serve('room', [String(candidate)])) as never;
    } catch {
      continue; // room index not in the mirror
    }
    for (const occupant of other.accounts.slice(0, 1)) {
      negatives++;
      note('roomNegatives');
      const roomIdx = asUint(await readRaw(contracts.room, occupant.id));
      if (roomIdx === BigInt(room.index)) {
        violations.push({ area: 'room', reason: 'negative sample reads as occupant', account: occupant.index });
      }
    }
  }
}

// --- merchant listings -------------------------------------------------------
const merchants = (await serve('merchant', [])) as { merchants: { index: number }[] };
for (const m of merchants.merchants) {
  const data = (await serve('merchant', [String(m.index)])) as {
    listings?: { id: string; value: number; balance: number; item: { index: number } }[];
  };
  for (const l of data.listings ?? []) {
    note('listings');
    const value = asUint(await readRaw(contracts.value, l.id));
    const balance = asUint(await readRaw(contracts.balance, l.id));
    const itemIdx = asUint(await readRaw(contracts.item, l.id));
    if (value !== BigInt(l.value) || balance !== BigInt(l.balance) || itemIdx !== BigInt(l.item.index)) {
      violations.push({
        area: 'merchant',
        npc: m.index,
        listing: l.id,
        served: { value: l.value, balance: l.balance, item: l.item.index },
        chain: { value: value?.toString(), balance: balance?.toString(), item: itemIdx?.toString() },
      });
    }
  }
}

// --- leaderboard sampled rows ------------------------------------------------
for (const [type, epoch, itemIndex] of [
  ['COLLECT', 1, 1],
  ['LIQUIDATE', 1, 0],
] as [string, number, number][]) {
  const lb = (await serve('leaderboard', [type, String(epoch), String(itemIndex)])) as {
    rows: { rank: number; account: { id: string }; value: number }[];
  };
  const sampled = lb.rows.filter((_, i) => i < 20 || i % 100 === 0);
  for (const row of sampled) {
    note(`scores:${type}`);
    const entity = getScoreEntity(world, row.account.id as EntityID, epoch, itemIndex, type);
    const scoreId = entity !== undefined ? world.entities[entity] : undefined;
    if (!scoreId) {
      violations.push({ area: 'leaderboard', type, rank: row.rank, reason: 'no is.score hash entity' });
      continue;
    }
    const value = asUint(await readRaw(contracts.value, scoreId));
    if (value !== BigInt(row.value)) {
      violations.push({ area: 'leaderboard', type, rank: row.rank, served: row.value, chain: value?.toString() });
    }
  }
}
provider.destroy();

await writeMeasurement('g6b-chain-crosscheck', {
  pinnedBlock,
  accountIndex,
  roomIndex: accountData.roomIndex,
  sampling: 'inventory/room/merchant exhaustive for the sampled entities; leaderboard top-20 + every 100th per board',
  counts,
  violations: violations.slice(0, 20),
  violationCount: violations.length,
  match: violations.length === 0 && Object.values(counts).every((n) => n > 0),
});

if (violations.length > 0) {
  fail('G6.b', { reason: 'chain mismatch', violations: violations.slice(0, 10), violationCount: violations.length });
}
if (Object.values(counts).some((n) => n === 0)) {
  fail('G6.b', { reason: 'a verification area sampled zero rows', counts });
}
pass('G6.b', counts);
process.exit(0);
