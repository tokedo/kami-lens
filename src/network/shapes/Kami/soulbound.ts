/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/shapes/Kami/soulbound.ts
 * changes:  Date.now() → clock.now() at 1 call site plus the clock import
 *           (§3.8: offset-corrected stream clock, not naive wall clock — see
 *           src/clock.ts; the pin-advance tripwire in test/clock.test.ts
 *           refuses a naive read here). Body otherwise verbatim.
 */

import * as clock from 'clock';
import { EntityID, World } from 'engine/recs';
import { formatEntityID } from 'engine/utils';
import { AbiCoder, keccak256 } from 'ethers';

import { Components } from 'network/components';
import { getValue } from '../utils/component';

const coder = AbiCoder.defaultAbiCoder();
const IDStore = new Map<EntityID, EntityID>();

// LibSoulbound keys the expiry by keccak256(abi.encode(kamiID, "SOULBOUND")), not packed
const getID = (kamiID: EntityID): EntityID => {
  let id = IDStore.get(kamiID);
  if (!id) {
    id = formatEntityID(keccak256(coder.encode(['uint256', 'string'], [kamiID, 'SOULBOUND'])));
    IDStore.set(kamiID, id);
  }
  return id;
};

// unix time (s) the kami's soulbind ends, 0 if it was never bound
export const getSoulboundEnd = (world: World, comps: Components, kamiID: EntityID): number => {
  const entity = world.entityToIndex.get(getID(kamiID));
  return entity === undefined ? 0 : getValue(comps, entity);
};

// a bound kami can't be sent, listed, sold to an offer, rerolled, sacrificed or unstaked
export const isSoulbound = (world: World, comps: Components, kamiID: EntityID): boolean => {
  return getSoulboundEnd(world, comps, kamiID) > clock.now() / 1000;
};
