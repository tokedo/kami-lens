/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
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
