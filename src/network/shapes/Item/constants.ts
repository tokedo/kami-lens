/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Item/constants.ts
 * changes:  none
 */

import { EntityID, EntityIndex } from 'engine/recs';
import { Item } from './types';

export const NullItem: Item = {
  ObjectType: 'ITEM',
  id: '0' as EntityID,
  entity: 0 as EntityIndex,
  index: 0,
  type: '',
  rarity: 0,
  for: '',
  image: '',
  name: 'None',
  requirements: { use: [] },
  effects: { use: [], equip: [] },
  is: {
    disabled: false,
    tradeable: false,
  },
};
