/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/shapes/utils/addresses.ts
 * changes:  none
 */

import { EntityID, HasValue, QueryFragment, runQuery, World } from 'engine/recs';
import { Components } from 'network/';
import { Address, getAddress, Hex, pad } from 'viem';
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
    const address = getAddress(pad(world.entities[results[0]] as Hex, { size: 20 }));
    AddressStore.set(compID, address);
    return world.entities[results[0]] as Address;
  } else return '0x000000000000000000000000000000000000dEaD';
};

export const getSystemAddr = (world: World, components: Components, sysID: string): Address => {
  if (AddressStore.has(sysID)) return AddressStore.get(sysID)!;

  const { Systems } = components;
  const toQuery: QueryFragment[] = [HasValue(Systems, { value: genID(sysID) })];
  const results = Array.from(runQuery(toQuery));
  if (results.length > 0) {
    const address = getAddress(pad(world.entities[results[0]] as Hex, { size: 20 }));
    AddressStore.set(sysID, address);
    return world.entities[results[0]] as Address;
  } else return '0x000000000000000000000000000000000000dEaD';
};

/////////////////
// UTILS

export const genID = (field: string): EntityID => {
  return hashArgs([field], ['string']);
};
