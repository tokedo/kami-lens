/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/network/shapes/Kami/constants.ts
 * changes:  none
 */

import { EntityID, EntityIndex } from 'engine/recs';

import { KAMI_BASE_URI } from 'constants/media';
import { Kami } from './types';

export const NullKami: Kami = {
  ObjectType: 'KAMI',
  entity: 0 as EntityIndex,
  id: '0' as EntityID,
  index: 0,
  image: `${KAMI_BASE_URI}blank.gif`,
  name: 'MissingNo.',
  state: '',
};
