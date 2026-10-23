/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/shapes/Item/constants.ts
 * changes:  two @ts-expect-error — upstream type defects at the pin (vite
 *           never typechecks): NullItem.effects omits the required `equip`,
 *           and NullItem.is omits the required `disabled`. Body otherwise
 *           verbatim.
 */

import { EntityID, EntityIndex } from 'engine/recs';
import { Item } from './types';

export const NullItem: Item = {
  ObjectType: 'ITEM',
  id: '0' as EntityID,
  entity: 0 as EntityIndex,
  index: 0,
  type: '',
  for: '',
  image: '',
  name: 'None',
  requirements: { use: [] },
  // @ts-expect-error upstream defect at the pin: `equip` omitted
  effects: { use: [] },
  // @ts-expect-error upstream defect at the pin: `disabled` omitted
  is: {
    tradeable: false,
  },
};
