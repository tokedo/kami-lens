// Gate G2.e [live] — the pool swap quote is CHAIN-EXACT (1.0.0, B6).
//
// A quote an agent trades on has to be the number the chain will pay, in both
// directions and in both modes. This gate serves `quote` from a mirror healed
// to near head, pins that mirror's block, and re-derives every served figure
// from the CHAIN at the same block:
//
//   - the pool's reserves (the pool entity's own inventory balances:
//     ValueComponent.safeGet(keccak256(abi.encodePacked("inventory.instance",
//     poolID, itemIndex))) — LibInventory.genID / getBalanceOf), its fee
//     (RateComponent.get(poolID) — LibPoolRegistry.getFeeBps) and its pause
//     bit (IsDisabledComponent.has(poolID)), each by eth_call at the block;
//   - the swap output from those reserves with an INDEPENDENT uint256
//     transcription of LibPool.calcAmountOut (written from the Solidity, not
//     from the ported client the lens serves).
//
// THE CONTRACT EXPOSES NO QUOTE VIEW. LibPool.calcAmountOut and quote() are
// `internal pure`; the only callable path is PoolSystem.swap, which moves
// items. So the brief's fallback applies: the swap formula applied to
// on-chain reserves at the same block. That is recorded in the measurement.
//
// Vector: the live MUSU<->Ether-Shard pool [1,103] and one other pool with
// non-zero reserves (the deepest other one), each in both directions, each
// EXACT_IN and EXACT_OUT, over amounts from the smallest that buys anything
// to a large fraction of the reserve. EXACT_OUT asserts minimality too:
// calcAmountOut(amountIn) >= ask and calcAmountOut(amountIn - 1) < ask.
//
// Base: `--snapshot <path>` (any recent mirror snapshot; the shared
// c2.v8snap fixture is ~1M blocks old). The base does not affect what is
// proved — the reference is the chain at the mirror's own block.

import { AbiCoder, Contract, keccak256, solidityPackedKeccak256, toUtf8Bytes } from 'ethers';
import path from 'node:path';

import { resolveConfig } from '../../src/config';
import { serveQuery } from '../../src/queries';
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
import { buildMirror } from './lib.mts';

const snapshotArg = (() => {
  const i = process.argv.indexOf('--snapshot');
  return i >= 0 ? process.argv[i + 1]! : path.join(ARTIFACTS_DIR, 'c2.v8snap');
})();

const MUSU = 1;
const SHARD = 103;

const t0 = Date.now();
const config = resolveConfig();
const cache = await loadCacheFromSnapshotFile(snapshotArg, config);
const snapshotBlock = cache.blockNumber;
{
  const p = makeProvider(config);
  const coarse = (await p.getBlockNumber()) - 6;
  console.log(`[g2.e] coarse heal ${cache.blockNumber} -> ${coarse}`);
  await replayOnto(cache, makeFetchWorldEvents(p, config), coarse, { provider: p });
  const target = (await p.getBlockNumber()) - 6;
  console.log(`[g2.e] delta re-pin ${cache.blockNumber} -> ${target}`);
  await replayOnto(cache, makeFetchWorldEvents(p, config), target, { provider: p });
  p.destroy();
}
const { world, components } = buildMirror(cache);
const mirror = { world, components, blockNumber: cache.blockNumber };
const pinnedBlock = cache.blockNumber;

async function serve(
  query: string,
  args: string[]
): Promise<{ ok: true; data: any } | { ok: false; code: string }> {
  try {
    return {
      ok: true,
      data: (await serveQuery(mirror, query, args, { stale: false, mode: 'daemon' })).data,
    };
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code ?? String(e) };
  }
}

// --- chain side: resolve component contracts through the world's registry --
const WORLD_ABI = ['function components() view returns (address)'];
const REGISTRY_ABI = ['function getEntitiesWithValue(bytes value) view returns (uint256[])'];
const UINT_ABI = [
  'function safeGet(uint256 entity) view returns (uint256)',
  'function get(uint256 entity) view returns (uint256)',
  'function has(uint256 entity) view returns (bool)',
];

const provider = makeProvider(config);
const worldContract = new Contract(config.worldAddress, WORLD_ABI, provider);
const componentsRegistry: string = await worldContract.components({ blockTag: pinnedBlock });
const registry = new Contract(componentsRegistry, REGISTRY_ABI, provider);

async function componentAt(id: string): Promise<Contract> {
  const encoded = AbiCoder.defaultAbiCoder().encode(['uint256'], [keccak256(toUtf8Bytes(id))]);
  const found: bigint[] = await registry.getEntitiesWithValue(encoded, { blockTag: pinnedBlock });
  if (found.length === 0)
    fail('G2.e', { reason: `component ${id} not in the registry`, pinnedBlock });
  return new Contract('0x' + found[0]!.toString(16).padStart(40, '0'), UINT_ABI, provider);
}
const valueComp = await componentAt('component.value');
const rateComp = await componentAt('component.rate');
const disabledComp = await componentAt('component.is.disabled');

async function call<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(400 * (attempt + 1)); // paced: never burst the public RPC
    }
  }
}

const poolIdOf = (a: number, b: number) => {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return BigInt(solidityPackedKeccak256(['string', 'uint32', 'uint32'], ['amm.pool', lo, hi]));
};
const inventoryId = (holder: bigint, item: number) =>
  BigInt(
    solidityPackedKeccak256(['string', 'uint256', 'uint32'], ['inventory.instance', holder, item])
  );

type ChainPool = { reserves: Map<number, bigint>; feeBps: bigint; disabled: boolean };
async function chainPool(a: number, b: number): Promise<ChainPool> {
  const id = poolIdOf(a, b);
  const reserves = new Map<number, bigint>();
  for (const item of [a, b]) {
    reserves.set(
      item,
      await call(
        () => valueComp.safeGet(inventoryId(id, item), { blockTag: pinnedBlock }) as Promise<bigint>
      )
    );
    await sleep(150);
  }
  const feeBps = await call(() => rateComp.get(id, { blockTag: pinnedBlock }) as Promise<bigint>);
  const disabled = await call(
    () => disabledComp.has(id, { blockTag: pinnedBlock }) as Promise<boolean>
  );
  return { reserves, feeBps, disabled };
}

// --- the independent uint256 LibPool.calcAmountOut --------------------------
const BPS = 10_000n;
const solOut = (amountIn: bigint, rIn: bigint, rOut: bigint, fee: bigint) => {
  const withFee = amountIn * (BPS - fee);
  return (withFee * rOut) / (rIn * BPS + withFee);
};

// --- choose the second pool from the mirror's own pool listing --------------
const items = await serve('items', []);
if (!items.ok) fail('G2.e', { reason: 'items query failed', code: items.code });
const pools = (
  items.data.pools as { items: number[]; reserves: number[]; disabled?: boolean }[]
).filter((p) => !p.disabled && p.reserves[0]! > 0 && p.reserves[1]! > 0);
const shardPool = pools.find((p) => p.items[0] === MUSU && p.items[1] === SHARD);
if (!shardPool) fail('G2.e', { reason: 'the MUSU/103 pool is not live in the mirror', pools });
const other = pools
  .filter((p) => !(p.items[0] === MUSU && p.items[1] === SHARD))
  .sort((x, y) => y.reserves[0]! * y.reserves[1]! - x.reserves[0]! * x.reserves[1]!)[0];
if (!other) fail('G2.e', { reason: 'no second live pool to cross-check', pools });

type Case = Record<string, unknown>;
const cases: Case[] = [];
const problems: Case[] = [];

for (const pair of [shardPool!.items, other!.items]) {
  const [a, b] = pair as [number, number];
  const chain = await chainPool(a, b);
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    const rIn = chain.reserves.get(from)!;
    const rOut = chain.reserves.get(to)!;
    // the smallest input that buys anything, then up to a third of the
    // input reserve; exact-out asks from 1 up to half the output reserve
    // the exact minimal input that buys anything: double past it, then
    // bisect back (minIn - 1 must buy nothing — the dust refusal below)
    let hi = 1n;
    while (solOut(hi, rIn, rOut, chain.feeBps) === 0n) hi *= 2n;
    let lo = hi / 2n;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (solOut(mid, rIn, rOut, chain.feeBps) === 0n) lo = mid;
      else hi = mid;
    }
    const minIn = hi;
    const ins = [minIn, minIn * 7n, rIn / 1000n, rIn / 100n, rIn / 10n, rIn / 3n].filter(
      (x) => x > 0n
    );
    const outs = [1n, rOut / 1000n, rOut / 100n, rOut / 10n, rOut / 2n].filter(
      (x) => x > 0n && x < rOut
    );
    const run = async (mode: 'EXACT_IN' | 'EXACT_OUT', amount: bigint) => {
      const args = [
        String(from),
        String(to),
        amount.toString(),
        ...(mode === 'EXACT_OUT' ? ['--exact-out'] : []),
      ];
      const res = await serve('quote', args);
      const c: Case = { pool: [a, b], from, to, mode, amount: amount.toString() };
      if (!res.ok) {
        c.served = res.code;
        problems.push({ ...c, reason: 'served an error for a quotable swap' });
        cases.push(c);
        return;
      }
      const d = res.data as {
        pool: { reserves: number[]; feeBps: number; items: number[] };
        amountIn: number;
        amountOut: number;
        feeAmountIn: number;
        reservesAfter: number[];
      };
      const servedReserves = new Map(
        d.pool.items.map((it, i) => [it, BigInt(d.pool.reserves[i]!)])
      );
      const amountIn = BigInt(d.amountIn);
      const chainOut = solOut(amountIn, rIn, rOut, chain.feeBps);
      c.amountIn = d.amountIn;
      c.amountOut = d.amountOut;
      c.chainAmountOut = chainOut.toString();
      if (servedReserves.get(from) !== rIn || servedReserves.get(to) !== rOut) {
        problems.push({
          ...c,
          reason: 'served reserves differ from chain',
          served: d.pool.reserves,
          chain: [rIn.toString(), rOut.toString()],
        });
      }
      if (BigInt(d.pool.feeBps) !== chain.feeBps) {
        problems.push({
          ...c,
          reason: 'served fee differs from chain',
          served: d.pool.feeBps,
          chain: chain.feeBps.toString(),
        });
      }
      if (BigInt(d.amountOut) !== chainOut) {
        problems.push({ ...c, reason: 'amountOut is not the chain formula at the chain reserves' });
      }
      // 1.0.0: the fee is an INTEGER in both modes — what the contract's
      // amountIn × (BPS − fee) pricing withholds — and the reserves after
      // the swap reconcile exactly with amountIn and amountOut
      const chainFee = amountIn - (amountIn * (BPS - chain.feeBps)) / BPS;
      c.feeAmountIn = d.feeAmountIn;
      if (!Number.isInteger(d.feeAmountIn) || BigInt(d.feeAmountIn) !== chainFee) {
        problems.push({
          ...c,
          reason: 'feeAmountIn is not the integer fee the contract withholds',
          chainFee: chainFee.toString(),
        });
      }
      if (
        BigInt(d.reservesAfter[0]!) !== rIn + amountIn ||
        BigInt(d.reservesAfter[1]!) !== rOut - chainOut
      ) {
        problems.push({
          ...c,
          reason: 'reservesAfter does not reconcile with the chain reserves',
          served: d.reservesAfter,
        });
      }
      if (mode === 'EXACT_IN' && amountIn !== amount) {
        problems.push({ ...c, reason: 'EXACT_IN changed the input' });
      }
      if (mode === 'EXACT_OUT') {
        const minimal =
          chainOut >= amount && solOut(amountIn - 1n, rIn, rOut, chain.feeBps) < amount;
        c.minimal = minimal;
        if (!minimal)
          problems.push({
            ...c,
            reason: 'EXACT_OUT input is not the minimal one covering the ask',
          });
      }
      cases.push(c);
    };
    for (const x of ins) await run('EXACT_IN', x);
    for (const x of outs) await run('EXACT_OUT', x);
    // the refusals the chain makes: an ask at the output reserve, and an
    // input that buys nothing
    const atReserve = await serve('quote', [
      String(from),
      String(to),
      rOut.toString(),
      '--exact-out',
    ]);
    cases.push({
      pool: [a, b],
      from,
      to,
      mode: 'EXACT_OUT',
      amount: rOut.toString(),
      served: atReserve.ok ? 'quote' : atReserve.code,
    });
    if (atReserve.ok || atReserve.code !== 'NOT_QUOTABLE') {
      problems.push({
        pool: [a, b],
        from,
        to,
        reason: 'an ask at the output reserve was not NOT_QUOTABLE',
      });
    }
    if (minIn > 1n) {
      const dust = await serve('quote', [String(from), String(to), (minIn - 1n).toString()]);
      cases.push({
        pool: [a, b],
        from,
        to,
        mode: 'EXACT_IN',
        amount: (minIn - 1n).toString(),
        served: dust.ok ? 'quote' : dust.code,
      });
      if (dust.ok || dust.code !== 'NOT_QUOTABLE') {
        problems.push({
          pool: [a, b],
          from,
          to,
          reason: 'an input that buys nothing was not NOT_QUOTABLE',
        });
      }
    }
  }
  if (chain.disabled)
    problems.push({
      pool: [a, b],
      reason: 'chain says the pool is disabled but the mirror listed it live',
    });
}

provider.destroy();
const elapsedMs = Date.now() - t0;
const file = await writeMeasurement('g2e-quote-chain', {
  gate: 'G2.e',
  snapshot: path.basename(snapshotArg),
  snapshotBlock,
  pinnedBlock,
  quoteViewOnChain:
    'none — LibPool.calcAmountOut/quote are internal pure and PoolSystem.swap moves items; compared against the swap formula (independent uint256 transcription) on on-chain reserves at pinnedBlock',
  pools: [shardPool!.items, other!.items],
  cases,
  casesTotal: cases.length,
  problems,
  elapsedMs,
  match: problems.length === 0,
});
if (problems.length > 0) fail('G2.e', { problems: problems.slice(0, 20), measurement: file });
pass('G2.e', {
  pools: [shardPool!.items, other!.items],
  cases: cases.length,
  pinnedBlock,
  elapsedMs,
  measurement: file,
});
