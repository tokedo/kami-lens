/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
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
