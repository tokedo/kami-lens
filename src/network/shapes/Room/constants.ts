/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Room/constants.ts
 * changes:  none
 */

import { EntityID, EntityIndex } from 'engine/recs';
import { Room } from './types';

export const NullRoom: Room = {
  index: 0,
  entity: 0 as EntityIndex,
  id: '' as EntityID,
  name: '',
  description: '',
  exits: [],
  gates: [],
  location: { x: 0, y: 0, z: 0 },
};
