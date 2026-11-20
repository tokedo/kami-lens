/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/network/shapes/Account/constants.ts
 * changes:  none
 */

import { EntityID, EntityIndex } from 'engine/recs';
import { Account } from './types';

export const NullAccount: Account = {
  ObjectType: 'ACCOUNT',
  id: '0' as EntityID,
  entity: 0 as EntityIndex,
  index: 0,
  operatorAddress: '0x000000000000000000000000000000000000dEaD',
  ownerAddress: '0x000000000000000000000000000000000000dEaD',
  name: '',
  pfpURI: '',

  coin: 0,
  roomIndex: 0,
  reputation: {
    agency: 0,
    mina: 0,
    nursery: 0,
  },
  stamina: { base: 0, shift: 0, boost: 0, sync: 0, rate: 0, total: 20 },
  time: {
    last: 0,
    action: 0,
    creation: 0,
  },
  kamis: [],
};
