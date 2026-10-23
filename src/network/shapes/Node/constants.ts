/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/shapes/Node/constants.ts
 * changes:  none
 */

import { EntityID, EntityIndex } from 'engine/recs';

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
};
