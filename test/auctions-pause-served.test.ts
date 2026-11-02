// 1.1.0 item 8 (§3.19, upstream pin 8fb6ea58): the auction pause window on
// the daemon's own path — the served `auctions` row.
//
// The chain halted and resumed, and the studio gave the auctions a pause
// window (LibAuctionRegistry.setPause → TimePause, packed start << 64 | end):
// LibAuction.calcBuy now counts elapsed time from getPriceStart, the start
// pushed forward by the part of the window that has passed. A served `price`
// that still counted from `time.start` would disagree with what a buy charges.
// These cases build an auction entity in a synthetic mirror (the real
// component registry, the real shapes, the real query) and read the answer
// through serveQuery, on a fake wall clock (offset 0, so the projection clock
// reads it):
//   - inside the window the price equals the price at the window's start;
//     after it the price resumes from there (equal to a window-less auction
//     at the same elapsed time) — and the row carries `pause` with the
//     window's numbers, schema-valid;
//   - an auction without a window serves no `pause` key at all;
//   - the null-price decision (`priceUnavailable`) reads the same clock: at
//     the window's end it equals the decision at the window's start, where a
//     window-less auction has decayed past the chain's fixed point;
//   - the STARTED check still flips at `time.start` (LibAuction.
//     verifyRequirements reads TimeStart), window or not.
// Constants are synthetic (upstream's START and a 3-day window), not live.

import Ajv from 'ajv/dist/2020';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as clock from 'clock';
import { setComponent } from 'engine/recs';
import { getAuctionByIndex } from 'network/shapes/Auction';
import { hashArgs } from 'network/shapes/utils';
import { auctionPriceOut } from '../src/queries/feeds';
import { loadSchema, serveQuery } from '../src/queries';
import { addRegistryItem, makeMirror, type SyntheticMirror } from './support/mirror';

const DAY = 86_400;
const START = 1_700_000_000;
const PAUSE = { start: START + DAY, end: START + 4 * DAY }; // a 3-day window after day 1

const ajv = new Ajv({ strict: true, allErrors: true });
ajv.addSchema(loadSchema('auctions' as never), 'auctions');

type Curve = { value: number; period: number; decay1e6: number; rate: number; sold: number };
/** upstream's own test curve (functions.test.ts) */
const UPSTREAM_CURVE: Curve = { value: 32_000, period: DAY, decay1e6: 750_000, rate: 32, sold: 0 };

/** An auction as LibAuctionRegistry.create writes one, plus (optionally) the
 * window setPause writes — the decoder renders a uint256 as '0x' + hex. */
function addAuction(
  m: SyntheticMirror,
  itemIndex: number,
  curve: Curve,
  pause?: { start: number; end: number }
) {
  const { world, components: c } = m;
  for (const [index, name] of [[itemIndex, `lot ${itemIndex}`], [1, 'MUSU']] as const) {
    setComponent(c.Description, addRegistryItem(m, index, name), { value: name });
  }
  const e = world.registerEntity({ id: hashArgs(['auction', itemIndex], ['string', 'uint32']) });
  setComponent(c.EntityType, e, { value: 'AUCTION' });
  setComponent(c.ItemIndex, e, { value: itemIndex });
  setComponent(c.CurrencyIndex, e, { value: 1 });
  setComponent(c.Value, e, { value: ('0x' + curve.value.toString(16)) as unknown as number });
  setComponent(c.Period, e, { value: curve.period });
  setComponent(c.Decay, e, { value: curve.decay1e6 });
  setComponent(c.Rate, e, { value: curve.rate });
  setComponent(c.Balance, e, { value: curve.sold });
  setComponent(c.Max, e, { value: 1_000_000 });
  setComponent(c.StartTime, e, { value: START });
  if (pause) {
    const packed = (BigInt(pause.start) << 64n) | BigInt(pause.end);
    setComponent(c.TimePause, e, { value: ('0x' + packed.toString(16)) as unknown as number });
  }
  return e;
}

type Row = { auctionItem?: { index: number }; pause?: { start: number; end: number }; price: number | null; priceUnavailable?: string };

/** the served auctions answer at unix second `t` */
async function rowsAt(m: SyntheticMirror, t: number): Promise<Map<number, Row>> {
  vi.setSystemTime(t * 1000);
  const data = (await serveQuery(m, 'auctions', [], { stale: false, mode: 'daemon' })).data;
  if (!ajv.validate('auctions', data)) throw new Error(`auctions schema: ${ajv.errorsText(ajv.errors)}`);
  const rows = (data as { auctions: Row[] }).auctions;
  return new Map(rows.map((r) => [r.auctionItem!.index, r]));
}

beforeEach(() => {
  clock.reset(); // offset 0: the projection clock reads the (fake) wall clock
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  clock.reset();
});

describe('1.1.0 item 8: the served auctions row across a pause window', () => {
  it('the price holds through the window and resumes from there; `pause` serves the window, and only where one is set', async () => {
    const m = makeMirror(9_000);
    addAuction(m, 10, UPSTREAM_CURVE, PAUSE); // windowed
    addAuction(m, 11, UPSTREAM_CURVE); // no window

    const atStart = await rowsAt(m, PAUSE.start);
    const inside = await rowsAt(m, PAUSE.start + DAY);
    const atEnd = await rowsAt(m, PAUSE.end);
    const after = await rowsAt(m, PAUSE.end + DAY);
    const plain2d = await rowsAt(m, START + 2 * DAY); // the window-less curve, 2 days in

    // before the window both curves agree
    expect(atStart.get(10)!.price).toBe(atStart.get(11)!.price);
    // inside and at the window's end: the price at the window's start
    expect(inside.get(10)!.price).toBe(atStart.get(10)!.price);
    expect(atEnd.get(10)!.price).toBe(atStart.get(10)!.price);
    // without the window the price kept decaying
    expect(atEnd.get(11)!.price!).toBeLessThan(atStart.get(11)!.price!);
    // one day after the window: elapsed is 2 days (1 before it, 1 after it)
    expect(after.get(10)!.price).toBe(plain2d.get(11)!.price);
    expect(after.get(10)!.price!).toBeLessThan(atStart.get(10)!.price!);

    // the window's numbers on the windowed row; no key on the other
    for (const rows of [atStart, inside, atEnd, after]) {
      expect(rows.get(10)!.pause).toEqual({ start: PAUSE.start, end: PAUSE.end });
      expect('pause' in rows.get(11)!).toBe(false);
    }
  });

  it('the null-price decision reads the same clock: at the window end it equals the decision at the window start, where a window-less auction has decayed past the fixed point', async () => {
    // decay 0.5 per minute: the chain's cost rounds to zero after ~3,588 s
    // (2^-59.79, PRBMath exp2) — COST_ROUNDS_TO_ZERO
    const steep: Curve = { value: 4_697, period: 60, decay1e6: 500_000, rate: 7, sold: 0 };
    const early = { start: START + 1_800, end: START + 1_800 + 3 * DAY }; // still priced at its start
    const late = { start: START + 3_600, end: START + 3_600 + 3 * DAY }; // already past it at its start
    const m = makeMirror(9_000);
    addAuction(m, 20, steep, early);
    addAuction(m, 21, steep); // no window
    addAuction(m, 22, steep, late);

    const eStart = await rowsAt(m, early.start);
    const eEnd = await rowsAt(m, early.end);
    expect(eStart.get(20)!.price).not.toBeNull();
    expect(eEnd.get(20)!.price).toBe(eStart.get(20)!.price);
    expect(eEnd.get(20)!.priceUnavailable).toBeUndefined();
    // the same curve without a window has decayed past the chain's range
    expect(eEnd.get(21)!).toMatchObject({ price: null, priceUnavailable: 'COST_ROUNDS_TO_ZERO' });

    const lStart = await rowsAt(m, late.start);
    const lEnd = await rowsAt(m, late.end);
    expect(lStart.get(22)!).toMatchObject({ price: null, priceUnavailable: 'COST_ROUNDS_TO_ZERO' });
    expect(lEnd.get(22)!).toMatchObject({ price: null, priceUnavailable: 'COST_ROUNDS_TO_ZERO' });
  });

  it('the STARTED check still flips at time.start, window or not', () => {
    // 200 units sold at rate 1 and decay 0.5: from the start the exponent is
    // +200, past PRBMath exp2's range — the chain refuses (BEYOND_FIXED_POINT_RANGE).
    // Before the start the chain refuses for a different reason ("auction has
    // not started"), and the row serves the ported curve as it always has.
    const heavy: Curve = { value: 100, period: 3_600, decay1e6: 500_000, rate: 1, sold: 200 };
    const m = makeMirror(9_000);
    addAuction(m, 30, heavy, { start: START + 600, end: START + 600 + DAY });
    addAuction(m, 31, heavy);
    for (const index of [30, 31]) {
      const a = getAuctionByIndex(m.world, m.components, index, { auctionItem: true, paymentItem: true });
      const before = auctionPriceOut(a, START - 1);
      expect(before.priceUnavailable).toBeUndefined();
      expect(before.price).not.toBeNull();
      expect(auctionPriceOut(a, START)).toEqual({ price: null, priceUnavailable: 'BEYOND_FIXED_POINT_RANGE' });
    }
    // half a day into the window auction 30 still reads 600 s elapsed (the
    // exponent 199.8, still refused); without the window 12.2 h have passed
    // and the exponent (187.8) is back inside the range — priced
    const t = START + 600 + DAY / 2;
    const windowed = getAuctionByIndex(m.world, m.components, 30, { auctionItem: true, paymentItem: true });
    const plain = getAuctionByIndex(m.world, m.components, 31, { auctionItem: true, paymentItem: true });
    expect(auctionPriceOut(windowed, t)).toEqual({ price: null, priceUnavailable: 'BEYOND_FIXED_POINT_RANGE' });
    expect(auctionPriceOut(plain, t).price).not.toBeNull();
  });
});
