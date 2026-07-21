/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Account/constants.ts
 * changes:  one @ts-expect-error — upstream type defect at the pin (vite
 *           never typechecks): NullAccount.reputation omits the mina/nursery
 *           fields its type requires. Body otherwise verbatim.
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
  // @ts-expect-error upstream defect at the pin: omits mina/nursery
  reputation: {
    agency: 0,
  },
  stamina: { base: 0, shift: 0, boost: 0, sync: 0, rate: 0, total: 20 },
  time: {
    last: 0,
    action: 0,
    creation: 0,
  },
  kamis: [],
};
