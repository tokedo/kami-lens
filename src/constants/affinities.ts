/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
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
