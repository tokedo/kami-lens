/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/network/shapes/Node/constants.ts
 * changes:  none
 */

import { EntityID, EntityIndex } from 'engine/recs';

import { MULT_PREC } from './multiplier';
import { Node } from './types';

export const NullNode: Node = {
  ObjectType: 'NODE',
  id: '0' as EntityID,
  index: 0,
  entity: 0 as EntityIndex,
  type: '' as string,
  image: '',
  roomIndex: 0,
  name: 'Empty Node',
  description: 'There is no node in this room.',
  affinity: ['NORMAL'] as string[],
  drops: [],
  requirements: [],
  multiplier: MULT_PREC,
};
