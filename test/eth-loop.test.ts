// 1.0.0 (B6): the ETH loop over the synthetic mirror — the ERC20 item token,
// the pool quote and pending portal receipts.
//
// The quote's arithmetic is checked here against an INDEPENDENT uint256
// transcription of LibPool (written from the Solidity, not from the ported
// client), over random reserves; gate G2.e then checks the served quote
// against on-chain reserves at the same block.

import Ajv from 'ajv/dist/2020';
import { getAddress } from 'ethers';
import { beforeEach, describe, expect, it } from 'vitest';

import * as clock from 'clock';
import { setComponent } from 'engine/recs';
import { hashArgs } from 'network/shapes/utils';
import { loadSchema, serveQuery } from '../src/queries';
import { REGISTRY } from '../src/queries/registry';
import { addAccount, makeMirror, type SyntheticMirror } from './support/mirror';

const ajv = new Ajv({ strict: true, allErrors: true });
for (const q of ['quote', 'receipts', 'item', 'items']) ajv.addSchema(loadSchema(q as never), q);
const valid = (q: string, data: unknown) => {
  const ok = ajv.validate(q, data);
  if (!ok) throw new Error(`${q} schema: ${ajv.errorsText(ajv.errors)}`);
  return ok;
};
const serve = (m: SyntheticMirror, q: string, args: string[]) =>
  serveQuery(m, q, args, { stale: false, mode: 'daemon' });

const MUSU = 1;
const SHARD = 103;
const TOKEN = '0x00000000000000000000000000000000000000e7';

function addItem(
  m: SyntheticMirror,
  index: number,
  name: string,
  erc20?: { address: string; scale: number }
) {
  const e = m.world.registerEntity({
    id: hashArgs(['registry.item', index], ['string', 'uint32']),
  });
  setComponent(m.components.EntityType, e, { value: 'ITEM' });
  setComponent(m.components.ItemIndex, e, { value: index });
  setComponent(m.components.Name, e, { value: name });
  setComponent(m.components.Type, e, { value: erc20 ? 'ERC20' : 'MISC' });
  setComponent(m.components.IsRegistry, e, { value: true });
  if (erc20) {
    setComponent(m.components.TokenAddress, e, { value: erc20.address });
    setComponent(m.components.Scale, e, { value: erc20.scale });
  }
  return e;
}

function setBalance(m: SyntheticMirror, holderId: string, item: number, amount: number) {
  const id = hashArgs(['inventory.instance', holderId, item], ['string', 'uint256', 'uint32']);
  const e = m.world.entityToIndex.get(id) ?? m.world.registerEntity({ id });
  setComponent(m.components.Value, e, { value: amount });
}

function addPool(
  m: SyntheticMirror,
  a: number,
  b: number,
  reserves: [number, number],
  feeBps = 30
) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const id = hashArgs(['amm.pool', lo, hi], ['string', 'uint32', 'uint32']);
  const e = m.world.registerEntity({ id });
  setComponent(m.components.EntityType, e, { value: 'POOL' });
  setComponent(m.components.Keys, e, { value: [lo, hi] as never });
  setComponent(m.components.Rate, e, { value: feeBps });
  setComponent(m.components.Value, e, { value: 1000 });
  const poolId = m.world.entities[e]!;
  setBalance(m, poolId, lo, reserves[0]);
  setBalance(m, poolId, hi, reserves[1]);
  return e;
}

function shardWorld() {
  const m = makeMirror(9_000);
  addItem(m, MUSU, 'Musu');
  addItem(m, SHARD, 'Ether Shard', { address: TOKEN, scale: 3 });
  addPool(m, MUSU, SHARD, [9_293_213, 15_328]);
  return m;
}

// --- an independent uint256 LibPool, from the Solidity ---------------------
const BPS = 10_000n;
const solOut = (amountIn: bigint, rIn: bigint, rOut: bigint, fee: bigint) => {
  const withFee = amountIn * (BPS - fee);
  return (withFee * rOut) / (rIn * BPS + withFee);
};

beforeEach(() => clock.reset());

describe('item token (B6)', () => {
  it('an ERC20 item serves {address, scale}; other items do not', async () => {
    const m = shardWorld();
    const shard = (await serve(m, 'item', ['103'])).data as Record<string, unknown>;
    expect(shard.token).toEqual({ address: TOKEN, scale: 3 });
    expect(valid('item', shard)).toBe(true);
    const musu = (await serve(m, 'item', ['1'])).data as Record<string, unknown>;
    expect('token' in musu).toBe(false);
    const list = (await serve(m, 'items', [])).data as {
      items: Record<string, unknown>[];
    };
    expect(list.items.find((i) => i.index === SHARD)?.token).toEqual({
      address: TOKEN,
      scale: 3,
    });
    expect(list.items.find((i) => i.index === MUSU)?.token).toBeUndefined();
    expect(valid('items', list)).toBe(true);
  });
});

describe('quote (B6)', () => {
  it('EXACT_IN both directions equals the uint256 formula on the same reserves', async () => {
    const m = shardWorld();
    const sell = (await serve(m, 'quote', ['1', '103', '100000'])).data as Record<string, number>;
    expect(sell.amountOut).toBe(Number(solOut(100_000n, 9_293_213n, 15_328n, 30n)));
    expect(sell.amountIn).toBe(100_000);
    expect(valid('quote', sell)).toBe(true);
    const buy = (await serve(m, 'quote', ['103', '1', '25'])).data as Record<string, number>;
    expect(buy.amountOut).toBe(Number(solOut(25n, 15_328n, 9_293_213n, 30n)));
  });

  it('EXACT_OUT: the minimal input whose chain output covers the ask', async () => {
    const m = shardWorld();
    const d = (await serve(m, 'quote', ['1', '103', '10', '--exact-out'])).data as Record<
      string,
      unknown
    >;
    const amountIn = BigInt(d.amountIn as number);
    expect(d.mode).toBe('EXACT_OUT');
    expect(solOut(amountIn, 9_293_213n, 15_328n, 30n)).toBeGreaterThanOrEqual(10n);
    expect(solOut(amountIn - 1n, 9_293_213n, 15_328n, 30n)).toBeLessThan(10n);
    expect(d.amountOut).toBe(Number(solOut(amountIn, 9_293_213n, 15_328n, 30n)));
    expect(valid('quote', d)).toBe(true);
  });

  it('random reserves, both modes: served == uint256 formula, exact-out minimal', async () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return 1 + (seed % n);
    };
    // ONE world, reserves and fee rewritten per case: the ported caches key
    // registry entities by EntityIndex for the life of the process, which is
    // right for the daemon (one world per LIVE) and wrong for a loop that
    // builds a fresh world per case
    const m = makeMirror(9_000);
    addItem(m, 11, 'A');
    addItem(m, 12, 'B');
    const poolE = addPool(m, 11, 12, [1, 1]);
    const poolId = m.world.entities[poolE]!;
    for (let i = 0; i < 200; i++) {
      const rA = rnd(50_000_000);
      const rB = rnd(50_000_000);
      const fee = rnd(100) - 1;
      setBalance(m, poolId, 11, rA);
      setBalance(m, poolId, 12, rB);
      setComponent(m.components.Rate, poolE, { value: fee });
      const amt = rnd(Math.max(1, Math.floor(rA / 3)));
      const out = solOut(BigInt(amt), BigInt(rA), BigInt(rB), BigInt(fee));
      if (out > 0n) {
        const d = (await serve(m, 'quote', ['11', '12', String(amt)])).data as Record<
          string,
          number
        >;
        expect(d.amountOut).toBe(Number(out));
        expect(d.reservesAfter).toEqual([rA + amt, rB - Number(out)]);
      }
      const ask = rnd(Math.max(1, rA - 1));
      if (ask < rA) {
        const d = (await serve(m, 'quote', ['12', '11', String(ask), '--exact-out']))
          .data as Record<string, number>;
        const ain = BigInt(d.amountIn);
        expect(solOut(ain, BigInt(rB), BigInt(rA), BigInt(fee))).toBeGreaterThanOrEqual(
          BigInt(ask)
        );
        expect(solOut(ain - 1n, BigInt(rB), BigInt(rA), BigInt(fee))).toBeLessThan(BigInt(ask));
      }
    }
  });

  it('NOT_QUOTABLE where the chain would refuse; NOT_FOUND with no pool; BAD_ARGS on the amount', async () => {
    const m = shardWorld();
    await expect(serve(m, 'quote', ['1', '103', '15328', '--exact-out'])).rejects.toMatchObject({
      code: 'NOT_QUOTABLE',
    });
    await expect(serve(m, 'quote', ['1', '103', '1'])).rejects.toMatchObject({
      code: 'NOT_QUOTABLE',
    }); // buys 0
    await expect(serve(m, 'quote', ['1', '7', '10'])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(serve(m, 'quote', ['1', '103', '0'])).rejects.toMatchObject({
      code: 'BAD_ARGS',
    });
    await expect(serve(m, 'quote', ['1', '103', '1.5'])).rejects.toMatchObject({
      code: 'BAD_ARGS',
    });
    await expect(serve(m, 'quote', ['1', '1', '5'])).rejects.toMatchObject({
      code: 'BAD_ARGS',
    });
    const poolE = m.world.entityToIndex.get(
      hashArgs(['amm.pool', 1, 103], ['string', 'uint32', 'uint32'])
    )!;
    setComponent(m.components.IsDisabled, poolE, { value: true });
    await expect(serve(m, 'quote', ['1', '103', '100000'])).rejects.toMatchObject({
      code: 'NOT_QUOTABLE',
    });
  });

  it('parses exactly three positionals', () => {
    expect(() => REGISTRY.quote.parseArgs(['1', '103'])).toThrow();
    expect(REGISTRY.quote.parseArgs(['--exact-out', '1', '103', '5'])).toEqual({
      from: 1,
      to: 103,
      amount: 5,
      exactOut: true,
    });
  });
});

describe('receipts (B6)', () => {
  function receiptWorld() {
    const m = shardWorld();
    const acc = addAccount(m, 77, []);
    const accId = m.world.entities[acc]!;
    setComponent(m.components.OwnerAddress, acc, {
      value: '0x00000000000000000000000000000000000000a1',
    });
    setComponent(m.components.OperatorAddress, acc, {
      value: '0x00000000000000000000000000000000000000b2',
    });
    const now = Math.floor(Date.now() / 1000);
    const mk = (n: number, endTime: number, opts: { lane?: boolean; paused?: boolean } = {}) => {
      const e = m.world.registerEntity({
        id: ('0x' + (0xabc000 + n).toString(16)) as never,
      });
      setComponent(m.components.EntityType, e, { value: 'TOKEN_RECEIPT' });
      setComponent(m.components.OwnsWithdrawalID, e, { value: accId });
      setComponent(m.components.ItemIndex, e, { value: SHARD });
      setComponent(m.components.TokenAddress, e, { value: TOKEN });
      // 2,500 shards at scale 3 = 2.5e18 base units: past 2^53 on purpose
      setComponent(m.components.Value, e, {
        value: '0x22b1c8c1227a0000' as never,
      });
      setComponent(m.components.Tax, e, { value: 25 });
      setComponent(m.components.StartTime, e, { value: endTime - 3600 });
      setComponent(m.components.TimeEnd, e, { value: endTime });
      if (opts.paused) setComponent(m.components.IsDisabled, e, { value: true });
      if (opts.lane) {
        const f = m.world.registerEntity({
          id: hashArgs(
            ['has.flag', m.world.entities[e]!, 'PORTAL_TO_OPERATOR'],
            ['string', 'uint256', 'string']
          ),
        });
        setComponent(m.components.HasFlag, f, { value: true });
      }
      return e;
    };
    mk(1, now + 600, { lane: true });
    mk(2, now - 60);
    mk(3, now - 120, { paused: true });
    return m;
  }

  it('serves every pending receipt: amounts exact, lane, payout, state, ordered by endTime', async () => {
    const m = receiptWorld();
    const env = await serve(m, 'receipts', ['77']);
    const d = env.data as {
      account: Record<string, unknown>;
      receiptsTotal: number;
      receipts: Record<string, unknown>[];
    };
    expect(valid('receipts', d)).toBe(true);
    expect(d.receiptsTotal).toBe(3);
    expect(d.receipts.map((r) => r.state)).toEqual(['PAUSED', 'CLAIMABLE', 'WAITING']);
    const [paused, claimable, waiting] = d.receipts;
    expect(claimable).toMatchObject({
      tokenAmount: '2500000000000000000',
      itemAmount: 2500,
      tax: 25,
      token: { address: getAddress(TOKEN), scale: 3 },
      claimableNow: true,
      secondsToClaimable: 0,
      lane: 'OWNER',
      payout: {
        route: 'OWNER',
        address: getAddress('0x00000000000000000000000000000000000000a1'),
      },
    });
    expect(paused).toMatchObject({ claimableNow: false, state: 'PAUSED' });
    expect(waiting).toMatchObject({
      claimableNow: false,
      lane: 'OPERATOR',
      payout: {
        route: 'OPERATOR',
        address: getAddress('0x00000000000000000000000000000000000000b2'),
      },
    });
    expect(waiting!.secondsToClaimable as number).toBeGreaterThan(500);
  });

  it('an account with nothing pending answers an empty list, and the doc line says what that means', async () => {
    const m = shardWorld();
    addAccount(m, 88, []);
    const d = (await serve(m, 'receipts', ['88'])).data as {
      receiptsTotal: number;
      receipts: unknown[];
    };
    expect(d).toMatchObject({ receiptsTotal: 0, receipts: [] });
    expect(REGISTRY.receipts.summary).toMatch(/PENDING/);
    expect(REGISTRY.receipts.summary).toMatch(/NOT that nothing was ever withdrawn/);
  });

  it('an unknown account is NOT_FOUND', async () => {
    const m = shardWorld();
    await expect(serve(m, 'receipts', ['999'])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
