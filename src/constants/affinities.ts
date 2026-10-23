/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/constants/affinities.ts
 * changes:  none
 */

import { eerieIcon, insectIcon, normalIcon, scrapIcon } from 'assets/images/icons/affinities';

export enum Affinity {
  Normal = 'NORMAL',
  Eerie = 'EERIE',
  Insect = 'INSECT',
  Scrap = 'SCRAP',
}

export const AffinityColors = {
  normal: '#F2F4FF',
  eerie: '#B575D0',
  insect: '#A1C181',
  scrap: '#D38D50',
};

export const AffinityIcons = {
  eerie: eerieIcon,
  normal: normalIcon,
  scrap: scrapIcon,
  insect: insectIcon,
};
