/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
