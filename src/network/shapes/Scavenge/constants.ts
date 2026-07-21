/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Scavenge/constants.ts
 * changes:  none
 */

import { EntityID, EntityIndex } from 'engine/recs';
import { ScavBar } from './types';

export const NullScavenge: ScavBar = {
  id: '0' as EntityID,
  entity: 0 as EntityIndex,
  index: 0,
  type: '',
  affinity: '',
  cost: 100,
  rewards: [],
};
