/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/shapes/Auction/pricing.ts
 * changes:  none (new upstream at 8fb6ea58)
 */

import type { Auction } from './types';

export interface PauseWindow {
  start: number; // last block timestamp before the halt
  end: number; // first block timestamp after
}

// TimePause layout: uint64 start << 64 | uint64 end. mirrors LibAuctionRegistry.packPause
export const unpackPause = (raw: string | bigint | number | undefined): PauseWindow => {
  if (raw === undefined) return { start: 0, end: 0 };
  const packed = BigInt(raw);
  const mask = (1n << 64n) - 1n;
  return { start: Number((packed >> 64n) & mask), end: Number(packed & mask) };
};

// the start time GDA pricing counts elapsed time from: the auction's start pushed forward
// by the part of its pause window that has passed by `time`. before the window nothing is
// skipped, during it time stands still, after it the whole window is skipped.
// mirrors LibAuction.getPriceStart
export const getPriceStart = (auction: Auction, time: number): number => {
  const { start, end } = auction.time.pause;
  if (end <= start || time <= start) return auction.time.start;
  const paused = time < end ? time - start : end - start;
  return auction.time.start + paused;
};
