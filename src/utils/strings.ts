/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/utils/strings.ts
 * changes:  none
 */

import { formatEntityID } from 'engine/utils';

// parse an ID into an EntityID
export const parseID = (id: string) => {
  return formatEntityID(id);
};

// abbreviate a string to a given length with ellipses
export const abbreviateString = (str: string, maxLength = 16) => {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
};

// convert a string to title case
export const toTitle = (s: string) => {
  const regex = /(^|[_\-\s])([a-z])/g;
  return s
    .toLowerCase()
    .replace(regex, (_, p1, p2) => `${p1 ? ' ' : ''}${p2.toUpperCase()}`)
    .trim();
};
