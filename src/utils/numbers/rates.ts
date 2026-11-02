/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/utils/numbers/rates.ts
 * changes:  none
 */

// converts a per-second rate to a per-hour rate string with a given precision
export const getRateDisplay = (rate: number | undefined, roundTo: number): string => {
  if (rate === undefined) rate = 0;
  let hourlyRate = rate * 3600;
  let display = hourlyRate.toString();
  if (roundTo) {
    hourlyRate *= 10 ** roundTo;
    hourlyRate = Math.round(hourlyRate);
    hourlyRate /= 10 ** roundTo;
    display = hourlyRate.toFixed(roundTo);
  }
  if (hourlyRate > 0) display = '+' + display;
  return display;
};
