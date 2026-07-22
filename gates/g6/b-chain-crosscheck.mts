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
//   · leaderboard: sampled rows (top 10 + every 200th per board — the
//     sampling is recorded, the row set is thousands) — the is.score hash
//     entity for (holder, epoch, index, type) reads component.value == the
//     served value.
//
// Execution note (first-run lesson, 2026-07-22): the read plan is
// collected up front and executed through a small concurrency pool —
// sequential reads with retry backoff outlast the RPC's shallow state
// window and the pinned block ages out mid-gate ("historical version not
// found"). The elapsed time and block distance are in the measurement.

import { AbiCoder, Contract } from 'ethers';
import path from 'node:path';

import { resolveConfig } from '../../src/config';
import { serveQuery } from '../../src/queries';
import { getCompAddr } from '../../src/network/shapes/utils/addresses';
import { queryInventoryInstance } from '../../src/network/shapes/Inventory';
import { getEntity as getScoreEntity } from '../../src/network/shapes/Score/utils';
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
  // two-stage heal (third first-run lesson): the coarse replay over a
  // day-old snapshot takes minutes, so a target computed before it is
  // already ~100 blocks stale when it lands — outside the state window
  // before the first read. Pay the long gap first, then re-pin with a
  // seconds-cheap delta replay to a freshly computed target.
  const p = makeProvider(config);
  const coarse = (await p.getBlockNumber()) - 6;
  console.log(`[g6.b] coarse heal ${cache.blockNumber} → ${coarse}`);
  await replayOnto(cache, makeFetchWorldEvents(p, config), coarse);
  const target = (await p.getBlockNumber()) - 6;
  console.log(`[g6.b] delta re-pin ${cache.blockNumber} → ${target}`);
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
// getCompAddr serves the registry value unpadded — RoomIndex's address is
// 39 hex digits and ethers would try to resolve it as an ENS name; pad to
// a full 20-byte address before constructing contracts
const compAddr = (key: string): string =>
  '0x' + getCompAddr(world, components, key).slice(2).padStart(40, '0');
const contracts = {
  value: new Contract(compAddr('component.value'), COMPONENT_ABI, provider),
  balance: new Contract(compAddr('component.balance'), COMPONENT_ABI, provider),
  room: new Contract(compAddr('component.index.room'), COMPONENT_ABI, provider),
  item: new Contract(compAddr('component.index.item'), COMPONENT_ABI, provider),
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
      await sleep(300 * (attempt + 1));
    } finally {
      if (via !== provider) via.destroy();
    }
  }
  return null;
}

const asUint = (raw: string | null): bigint | null => (raw === null ? null : (abi.decode(['uint256'], raw)[0] as bigint));

// --- the read plan -----------------------------------------------------------
type Check = {
  area: string;
  contract: Contract;
  entityId: string;
  /** eq: chain value must equal expect; neq: must differ (negative sample) */
  kind: 'eq' | 'neq';
  expect: bigint;
  meta: Record<string, unknown>;
};
const plan: Check[] = [];
const violations: Record<string, unknown>[] = [];
const counts: Record<string, number> = {};
const note = (area: string, n = 1) => (counts[area] = (counts[area] ?? 0) + n);

// --- sampling stays cheap on purpose (second first-run lesson): everything
// between the heal and the reads counts against the RPC state window, so
// the sample account comes from the leaderboard's top row (a fast score
// scan + account join) — not from a forced-refresh kami sweep.
const collectBoard = (await serve('leaderboard', [])) as {
  rows: { account: { index?: number } }[];
};
const boardAccounts = collectBoard.rows
  .map((r) => r.account.index)
  .filter((i): i is number => i !== undefined);
const accountIndex = boardAccounts[0] ?? 0;
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
  plan.push({ area: 'inventory', contract: contracts.value, entityId: invId, kind: 'eq', expect: BigInt(row.balance), meta: { item: row.item.index, field: 'balance' } });
  plan.push({ area: 'inventory', contract: contracts.item, entityId: invId, kind: 'eq', expect: BigInt(row.item.index), meta: { item: row.item.index, field: 'itemIndex' } });
}

// --- room --------------------------------------------------------------------
const room = (await serve('room', [String(accountData.roomIndex)])) as {
  index: number;
  accounts: { id: string; index: number }[];
};
for (const occupant of room.accounts) {
  note('roomOccupants');
  plan.push({ area: 'room', contract: contracts.room, entityId: occupant.id, kind: 'eq', expect: BigInt(room.index), meta: { account: occupant.index } });
}
// negatives from other leaderboard accounts reported in different rooms —
// one cheap account query each, no room sweeps
{
  let negatives = 0;
  for (const candidate of boardAccounts.slice(1)) {
    if (negatives >= 5) break;
    const acc = (await serve('account', [String(candidate)])) as { id: string; roomIndex: number };
    if (acc.roomIndex === room.index) continue;
    negatives++;
    note('roomNegatives');
    plan.push({ area: 'room-negative', contract: contracts.room, entityId: acc.id, kind: 'neq', expect: BigInt(room.index), meta: { account: candidate, reportedRoom: acc.roomIndex } });
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
    plan.push({ area: 'merchant', contract: contracts.value, entityId: l.id, kind: 'eq', expect: BigInt(l.value), meta: { npc: m.index, listing: l.id, field: 'value' } });
    plan.push({ area: 'merchant', contract: contracts.balance, entityId: l.id, kind: 'eq', expect: BigInt(l.balance), meta: { npc: m.index, listing: l.id, field: 'balance' } });
    plan.push({ area: 'merchant', contract: contracts.item, entityId: l.id, kind: 'eq', expect: BigInt(l.item.index), meta: { npc: m.index, listing: l.id, field: 'itemIndex' } });
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
  const sampled = lb.rows.filter((_, i) => i < 10 || i % 200 === 0);
  for (const row of sampled) {
    note(`scores:${type}`);
    const entity = getScoreEntity(world, row.account.id as EntityID, epoch, itemIndex, type);
    const scoreId = entity !== undefined ? world.entities[entity] : undefined;
    if (!scoreId) {
      violations.push({ area: 'leaderboard', type, rank: row.rank, reason: 'no is.score hash entity' });
      continue;
    }
    plan.push({ area: `leaderboard:${type}`, contract: contracts.value, entityId: scoreId, kind: 'eq', expect: BigInt(row.value), meta: { type, rank: row.rank } });
  }
}

// --- execute the plan through a concurrency pool ----------------------------
const verifyStartedAt = Date.now();
const CONCURRENCY = 8;
let cursor = 0;
async function worker(): Promise<void> {
  while (cursor < plan.length) {
    const check = plan[cursor++];
    const got = asUint(await readRaw(check.contract, check.entityId));
    const ok = check.kind === 'eq' ? got === check.expect : got !== check.expect;
    if (!ok) {
      violations.push({ area: check.area, ...check.meta, expect: check.expect.toString(), chain: got?.toString() ?? null, kind: check.kind });
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
const verifyElapsedMs = Date.now() - verifyStartedAt;
const headAfter = await provider.getBlockNumber();
provider.destroy();

await writeMeasurement('g6b-chain-crosscheck', {
  pinnedBlock,
  headAfterVerify: headAfter,
  blocksBehindAtEnd: headAfter - pinnedBlock,
  verifyElapsedMs,
  reads: plan.length,
  concurrency: CONCURRENCY,
  accountIndex,
  roomIndex: accountData.roomIndex,
  sampling:
    'inventory/room/merchant exhaustive for the sampled entities; leaderboard top-10 + every 200th per board',
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
pass('G6.b', { ...counts, reads: plan.length, verifyElapsedMs });
process.exit(0);
