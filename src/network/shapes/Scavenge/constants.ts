/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
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
