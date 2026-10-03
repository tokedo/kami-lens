// kami-lens native module (not a port): the ETH loop made perceivable (1.0.0,
// B6) — pending portal receipts and a pool swap quote, both read from the
// mirror through the reference client's own shapes and pricing.
//
// `receipts` serves PENDING receipts only, and that is a property of the
// world, not a choice: the token portal deletes a TOKEN_RECEIPT entity
// outright when it is claimed or cancelled (LibTokenPortal.removeReceipt), so
// the mirror cannot hold a settled one. An empty list therefore means "nothing
// waiting", never "nothing ever withdrawn"; history is the Kamiden-backed
// `portal` query. Every field is one the contract reads at claim time, and
// the doc comments below say which.
//
// `quote` is the reference client's pool pricing (network/shapes/Pool,
// ported verbatim at the 1.0.0 pin: BigInt, floors matching LibPool) over
// the mirror's reserves. It is chain-exact BY CONSTRUCTION only if the
// reserves and the formula are — so gate G2.e re-derives the same numbers
// from on-chain reserves at the same block with an independent uint256
// implementation, both directions, both modes.

import * as clock from 'clock';
import { EntityID, EntityIndex, getComponentValue } from 'engine/recs';
import { formatEntityID } from 'engine/utils';
import {
  getAccountByIndex,
  getAccountByName,
  getAccountByOperator,
  getAccountByOwner,
} from 'network/shapes/Account';
import { hasFlag } from 'network/shapes/Flag';
import { getItemByIndex } from 'network/shapes/Item';
import {
  calcAmountIn,
  calcAmountOut,
  getPoolByItems,
  quote as spotQuote,
} from 'network/shapes/Pool';
import { queryReceiptsByAccount } from 'network/shapes/Portal';
import {
  getEndTime,
  getIsDisabled,
  getItemIndex,
  getKeys,
  getStartTime,
  getTax,
  getTokenAddress,
} from 'network/shapes/utils/component';

import { parseAddress } from 'utils/address';

import { Mirror, QueryError } from './build';

// ------------------------------------------------------------ receipts

/** The flag `TokenPortalSystem.withdrawToOperator` sets on a receipt
 * (OPERATOR_LANE_FLAG). Its presence routes the claim's payout to the
 * account's operator; its absence, to the owner. */
export const OPERATOR_LANE_FLAG = 'PORTAL_TO_OPERATOR';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export type ReceiptLane = 'OWNER' | 'OPERATOR';
export type ReceiptState = 'WAITING' | 'CLAIMABLE' | 'PAUSED';

export type PendingReceiptOut = {
  /** the TOKEN_RECEIPT entity id — what claim/cancel take */
  id: string;
  item: { index: number; name: string };
  /** net item units the receipt represents: toGameUnits(tokenAmount, scale),
   * the conversion the contract applies (LibERC20) */
  itemAmount: number;
  /** what the claim transfers, in token base units (18 dp) — a uint256 as a
   * decimal string, never a float */
  tokenAmount: string;
  /** export tax already taken at withdraw time, in item units (not refunded
   * on cancel) */
  tax: number;
  /** the token and scale the claim uses — the item registry's ERC20
   * registration, which the portal mirrors into its own storage. When the
   * item has been unregistered: the receipt's own recorded address, scale 0
   * (what a cancel would then convert with), and state PAUSED. */
  token: { address: string; scale: number };
  startTime: number;
  endTime: number;
  /** claim would not revert on time or pause right now: endTime <= the
   * projection clock and the receipt is not paused. The portal-wide on/off
   * switch is contract storage and NOT mirrored. */
  claimableNow: boolean;
  /** max(0, endTime - the projection clock), seconds */
  secondsToClaimable: number;
  /** OPERATOR when the receipt carries PORTAL_TO_OPERATOR */
  lane: ReceiptLane;
  /** where a claim made NOW would pay. The contract resolves the operator at
   * CLAIM time, so an operator change before the claim changes this. */
  payout: { route: ReceiptLane; address: string };
  /** PAUSED: an admin disabled this receipt (or unregistered its item);
   * CLAIMABLE: endTime reached; WAITING: not yet */
  state: ReceiptState;
};

export type ReceiptsOut = {
  account: { index: number; name: string; ownerAddress: string; operatorAddress: string };
  /** pending receipts held by the account — every one is served (a portal
   * receipt is per-withdrawal and an account holds a handful) */
  receiptsTotal: number;
  /** ordered by endTime, then id */
  receipts: PendingReceiptOut[];
};

type AccountKey = { index?: number; name?: string; address?: string };

/** The `account` query's lookup: index, name, or an address tried as owner
 * then operator (§3.14). */
function resolveAccount(mirror: Mirror, key: AccountKey) {
  const { world, components } = mirror;
  const account =
    key.index !== undefined
      ? getAccountByIndex(world, components, key.index)
      : key.name !== undefined
        ? getAccountByName(world, components, key.name)
        : key.address !== undefined
          ? (() => {
              const owned = getAccountByOwner(world, components, key.address!);
              if (owned.index) return owned;
              const operated = getAccountByOperator(world, components, key.address!);
              return operated.index ? operated : owned;
            })()
          : undefined;
  if (!account)
    throw new QueryError('BAD_ARGS', 'receipts needs an account index, a name or an address');
  if (!account.index) {
    throw new QueryError(
      'NOT_FOUND',
      `account ${key.index ?? key.name ?? key.address} not in mirror`
    );
  }
  return account;
}

/** A mirror address component as served — checksummed exactly as the
 * `account` query serves it, but never the client's 0x…dEaD "absent"
 * sentinel: an absent address is the zero address, which is what the
 * contract reads too. */
function addressOrZero(
  mirror: Mirror,
  component: 'OwnerAddress' | 'OperatorAddress',
  entity: EntityIndex
) {
  const raw = getComponentValue(mirror.components[component], entity)?.value;
  if (raw === undefined || raw === null) return ZERO_ADDRESS;
  return parseAddress(String(raw));
}

export function receiptsQuery(mirror: Mirror, key: AccountKey): ReceiptsOut {
  const { world, components } = mirror;
  const account = resolveAccount(mirror, key);
  const accountEntity = account.entity;
  const ownerAddress = addressOrZero(mirror, 'OwnerAddress', accountEntity);
  const operatorAddress = addressOrZero(mirror, 'OperatorAddress', accountEntity);
  const nowSec = Math.floor(clock.now() / 1000);

  const rows: PendingReceiptOut[] = [];
  for (const entity of queryReceiptsByAccount(components, account.id as EntityID)) {
    // the account join is a receipt fact; an entity that is no longer a
    // receipt (a removal mid-apply) is not served
    if (getComponentValue(components.EntityType, entity)?.value !== 'TOKEN_RECEIPT') continue;
    const itemIndex = getItemIndex(components, entity);
    const item = getItemByIndex(world, components, itemIndex);
    const rawValue = getComponentValue(components.Value, entity)?.value ?? 0;
    let tokenAmount: bigint;
    try {
      tokenAmount = BigInt(rawValue as string | number);
    } catch {
      tokenAmount = 0n;
    }
    const registered = item.token !== undefined;
    const scale = registered ? item.token!.scale : 0;
    const tokenAddress = registered ? item.token!.address : getTokenAddress(components, entity);
    const itemAmount = Number(tokenAmount / 10n ** BigInt(18 - Math.min(18, Math.max(0, scale))));
    const endTime = getEndTime(components, entity);
    const paused = getIsDisabled(components, entity) || !registered;
    const lane: ReceiptLane = hasFlag(world, components, entity, OPERATOR_LANE_FLAG)
      ? 'OPERATOR'
      : 'OWNER';
    const due = endTime <= nowSec;
    rows.push({
      id: world.entities[entity]!,
      item: { index: itemIndex, name: item.name },
      itemAmount,
      tokenAmount: tokenAmount.toString(),
      tax: getTax(components, entity),
      token: { address: tokenAddress, scale },
      startTime: getStartTime(components, entity),
      endTime,
      claimableNow: due && !paused,
      secondsToClaimable: Math.max(0, endTime - nowSec),
      lane,
      payout: { route: lane, address: lane === 'OPERATOR' ? operatorAddress : ownerAddress },
      state: paused ? 'PAUSED' : due ? 'CLAIMABLE' : 'WAITING',
    });
  }
  rows.sort((a, b) => a.endTime - b.endTime || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  return {
    account: { index: account.index, name: account.name, ownerAddress, operatorAddress },
    receiptsTotal: rows.length,
    receipts: rows,
  };
}

// --------------------------------------------------------------- quote

export type QuoteMode = 'EXACT_IN' | 'EXACT_OUT';

export type QuoteOut = {
  pool: {
    id: string;
    /** the pair, canonically sorted low index first (the pool's own key) */
    items: [number, number];
    /** aligned to `items` */
    reserves: [number, number];
    feeBps: number;
  };
  from: { index: number; name: string };
  to: { index: number; name: string };
  mode: QuoteMode;
  /** what the swap takes from the caller (EXACT_OUT: the smallest input
   * whose output covers the ask — upstream calcAmountIn, ceil) */
  amountIn: number;
  /** what the chain pays for `amountIn` (LibPool.calcAmountOut, floor). In
   * EXACT_OUT mode this is >= the amount asked for, usually equal. */
  amountOut: number;
  /** the fee share of amountIn, in input units: amountIn × feeBps / 10000.
   * May be fractional — the pool keeps it as reserve. */
  feeAmountIn: number;
  /** amountIn at the pre-trade reserve ratio, no fee, no impact
   * (upstream quote(): floor(amountIn × reserveOut / reserveIn)) */
  spotAmountOut: number;
  /** the curve's cost beyond the fee, in basis points of the fee-adjusted
   * ideal output: round(10000 × (1 − amountOut / (amountIn × (1 − fee) ×
   * reserveOut / reserveIn))). Display figure; the amounts are exact. */
  priceImpactBps: number;
  /** [from-side reserve, to-side reserve] after this swap: the whole
   * amountIn (fee included) enters, amountOut leaves */
  reservesAfter: [number, number];
};

export function parseQuoteAmount(raw: string | undefined): number {
  const n = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new QueryError(
      'BAD_ARGS',
      `quote amount must be a positive integer (item units), got '${raw ?? ''}'`
    );
  }
  return n;
}

export function quoteQuery(
  mirror: Mirror,
  args: { from: number; to: number; amount: number; exactOut?: boolean }
): QuoteOut {
  const { world, components } = mirror;
  if (args.from === args.to) throw new QueryError('BAD_ARGS', 'quote needs two different items');
  const pool = getPoolByItems(world, components, args.from, args.to);
  if (!pool || getComponentValue(components.EntityType, pool.entity)?.value !== 'POOL') {
    throw new QueryError('NOT_FOUND', `no pool for items ${args.from} and ${args.to}`);
  }
  // direction from the pool's OWN keys (canonical low-first, LibPoolRegistry)
  // and the items read fresh from the registry shape: the ported Pool getter
  // resolves itemA/itemB through app/cache/item, which keys registry
  // entities by EntityIndex for the life of the process — right for the
  // daemon's one world, not something a quote should rest on
  const [indexA, indexB] = getKeys(components, pool.entity);
  if (indexA === undefined || indexB === undefined) {
    throw new QueryError('NOT_FOUND', `pool ${args.from}/${args.to} has no item pair`);
  }
  const fromIsA = indexA === args.from;
  const fromItem = getItemByIndex(world, components, args.from);
  const toItem = getItemByIndex(world, components, args.to);
  if (!fromItem.index || !toItem.index) {
    throw new QueryError(
      'NOT_FOUND',
      `item ${fromItem.index ? args.to : args.from} not in the registry`
    );
  }
  const reserveIn = fromIsA ? pool.reserveA : pool.reserveB;
  const reserveOut = fromIsA ? pool.reserveB : pool.reserveA;
  const feeBps = pool.feeBps;
  const mode: QuoteMode = args.exactOut ? 'EXACT_OUT' : 'EXACT_IN';

  // NOT_QUOTABLE: every case where PoolSystem.swap would revert on the pool
  // itself, so a served quote is one the chain will execute
  const refuse = (why: string): never => {
    throw new QueryError('NOT_QUOTABLE', `pool ${args.from}/${args.to}: ${why}`);
  };
  if (pool.disabled) refuse('the pool is disabled');
  if (!fromItem.is.tradeable || !toItem.is.tradeable) refuse('an item in the pair is not tradable');
  if (reserveIn <= 0 || reserveOut <= 0) refuse(`a reserve is zero (${reserveIn}, ${reserveOut})`);

  let amountIn: number;
  if (mode === 'EXACT_OUT') {
    if (args.amount >= reserveOut) {
      refuse(`asks ${args.amount} of item ${toItem.index}, the reserve holds ${reserveOut}`);
    }
    amountIn = calcAmountIn(args.amount, reserveIn, reserveOut, feeBps);
  } else {
    amountIn = args.amount;
  }
  const amountOut = calcAmountOut(amountIn, reserveIn, reserveOut, feeBps);
  if (amountOut <= 0)
    refuse(`an input of ${amountIn} buys nothing (the swap reverts on zero output)`);

  const ideal = (amountIn * (1 - feeBps / 10_000) * reserveOut) / reserveIn;
  const priceImpactBps = ideal > 0 ? Math.round(10_000 * (1 - amountOut / ideal)) : 0;
  const items: [number, number] = [indexA, indexB];
  return {
    pool: {
      id: formatEntityID(pool.id),
      items,
      reserves: [pool.reserveA, pool.reserveB],
      feeBps,
    },
    from: { index: fromItem.index, name: fromItem.name },
    to: { index: toItem.index, name: toItem.name },
    mode,
    amountIn,
    amountOut,
    feeAmountIn: (amountIn * feeBps) / 10_000,
    spotAmountOut: spotQuote(amountIn, reserveIn, reserveOut),
    priceImpactBps: Math.max(0, priceImpactBps),
    reservesAfter: [reserveIn + amountIn, reserveOut - amountOut],
  };
}
