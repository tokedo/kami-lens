/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/utils/addresses.ts
 * changes:  two @ts-expect-error — upstream type defects at the pin (vite
 *           never typechecks): both getters feed an EntityID string into
 *           viem's pad()/getAddress(), whose signatures accept neither the
 *           tagged string nor the ByteArray union member. Runtime behavior
 *           is unchanged (the value is a hex string). Also on the record,
 *           unchanged: `import { result } from 'lodash'` is an auto-import
 *           accident upstream — getSystemAddr's `result.length > 0` tests
 *           that lodash function's arity (always > 0), so the dead-address
 *           fallback is unreachable and a missing Systems row throws in
 *           pad() upstream and here alike. Bodies otherwise verbatim.
 */

import { EntityID, HasValue, QueryFragment, runQuery, World } from 'engine/recs';
import { result } from 'lodash';
import { Components } from 'network/';
import { Address, getAddress, pad } from 'viem';
import { hashArgs } from './IDs';

const AddressStore = new Map<string, Address>();

/////////////////
// QUERIES

export const getCompAddr = (world: World, components: Components, compID: string): Address => {
  if (AddressStore.has(compID)) return AddressStore.get(compID)!;

  const { Components } = components;
  const toQuery: QueryFragment[] = [HasValue(Components, { value: genID(compID) })];
  const results = Array.from(runQuery(toQuery));
  if (results.length > 0) {
    // @ts-expect-error upstream defect at the pin: EntityID vs viem pad/getAddress types
    const address = getAddress(pad(world.entities[results[0]], { size: 20 }));
    AddressStore.set(compID, address);
    return world.entities[results[0]] as Address;
  } else return '0x000000000000000000000000000000000000dEaD';
};

export const getSystemAddr = (world: World, components: Components, sysID: string): Address => {
  if (AddressStore.has(sysID)) return AddressStore.get(sysID)!;

  const { Systems } = components;
  const toQuery: QueryFragment[] = [HasValue(Systems, { value: genID(sysID) })];
  const results = Array.from(runQuery(toQuery));
  if (result.length > 0) {
    // @ts-expect-error upstream defect at the pin: EntityID vs viem pad/getAddress types
    const address = getAddress(pad(world.entities[results[0]], { size: 20 }));
    AddressStore.set(sysID, address);
    return world.entities[results[0]] as Address;
  } else return '0x000000000000000000000000000000000000dEaD';
};

/////////////////
// UTILS

export const genID = (field: string): EntityID => {
  return hashArgs([field], ['string']);
};
