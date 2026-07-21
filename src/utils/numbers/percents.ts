/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/utils/numbers/percents.ts
 * changes:  none
 */

// calculate the percent of curr/tot. rounds down
export const calcPercent = (curr: number, tot: number, decimals = 1) => {
  if (tot === 0) return 0;
  const boost = 10 ** decimals;
  return Math.floor((curr / tot) * 100 * boost) / boost;
};

// calculate the percent of curr/tot. rounds down, cap at min/max
export const calcPercentBounded = (curr: number, tot: number, decimals = 1, min = 0, max = 100) => {
  const percent = calcPercent(curr, tot, decimals);
  return Math.min(max, Math.max(min, percent));
};

// calculate the percent of curr/tot. round down, cap at 100
export const calcPercentCompletion = (curr: number, tot: number, decimals = 1) => {
  if (curr >= tot) return 100;
  const truncated = calcPercent(curr, tot, decimals);
  return Math.min(100, truncated);
};
