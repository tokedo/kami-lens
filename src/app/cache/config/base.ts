/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/app/cache/config/base.ts
 * changes:  processArray and processValue no longer cache a read that came
 *           back EMPTY or absent (SPEC §4.2, "config sentinel reads are not
 *           cached"). Upstream caches unconditionally, so a single read that
 *           lands before the config Value components have hydrated is stored
 *           for the process lifetime and never re-fetched — permanently NaN
 *           vitals for every harvesting kami. The same guard already exists
 *           one function up: processAddress refuses to cache its own
 *           `0x…dEaD` sentinel. This applies that rule to the other two
 *           caches, and getAddress/getArray/getValue now return the value
 *           that was just read rather than the cache entry that may
 *           deliberately not exist (upstream's non-null assertion on the
 *           cache hides the same hole for addresses already).
 */

import { World } from 'engine/recs';
import { Address } from 'viem';

import { Components } from 'network/components';
import {
  getConfigFieldValue,
  getConfigFieldValueAddress,
  getConfigFieldValueArray,
} from 'network/shapes/Config';

export const AddressCache = new Map<string, Address>();
export const ArrayCache = new Map<string, number[]>();
export const ValueCache = new Map<string, number>();
export const UpdateTs = new Map<string, number>(); // last update ts of config field

export const getAddress = (world: World, components: Components, field: string): Address => {
  // return the value processAddress READ, not the cache entry it may
  // deliberately not have written. Upstream returns `AddressCache.get(field)!`
  // here, which is `undefined` for exactly the sentinel its own guard one
  // function down refuses to cache — the non-null assertion hides it. Latent
  // upstream because no caller reads an unset address field; fatal here once
  // the same guard is applied to the other two caches (§4.2).
  if (!AddressCache.has(field)) return processAddress(world, components, field) as Address;
  return AddressCache.get(field)!;
};

export const processAddress = (world: World, components: Components, field: string): string => {
  const address = getConfigFieldValueAddress(world, components, field);
  if (address != '0x000000000000000000000000000000000000dEaD') AddressCache.set(field, address);
  return address;
};

// get an array type of config field
export const getArray = (world: World, components: Components, field: string): number[] => {
  // same rule as getAddress above: serve what was read this time round, so a
  // sentinel that was deliberately not cached is still answered with (and
  // retried on the next call) rather than returning undefined (§4.2)
  if (!ArrayCache.has(field)) return processArray(world, components, field);
  return ArrayCache.get(field)!;
};

// process an array type of config field
export const processArray = (world: World, components: Components, field: string): number[] => {
  const values = getConfigFieldValueArray(world, components, field);
  // DIVERGENCE (§4.2): do not cache a sentinel. getConfigFieldValueArray
  // answers [] when the config entity exists but its Value component has not
  // hydrated yet, and eight zeros when the entity itself is missing. Caching
  // either one freezes it forever — getArray never re-fetches a cached field
  // — and [] in particular structures into NaN rather than zero, so it also
  // slips past the isFalsey re-read guard downstream. Leave the cache empty
  // and let the next read try again.
  if (isRealConfigArray(values)) ArrayCache.set(field, values);
  return values;
};

/** A config array is real when it has entries and at least one of them is a
 * finite non-zero number. Eight zeros is the entity-missing sentinel; an
 * empty array is the value-not-yet-hydrated sentinel. */
export const isRealConfigArray = (values: number[]): boolean =>
  values.length > 0 && values.some((v) => Number.isFinite(v) && v !== 0);

export const getValue = (world: World, components: Components, field: string): number => {
  if (!ValueCache.has(field)) return processValue(world, components, field);
  return ValueCache.get(field)!;
};

export const processValue = (world: World, components: Components, field: string): number => {
  const value = getConfigFieldValue(world, components, field);
  // DIVERGENCE (§4.2), same rule as processArray: getConfigFieldValue answers
  // 0 for a config entity that is missing OR not yet hydrated, and a cached 0
  // is never re-read. A config field that genuinely holds 0 costs one repeated
  // component read per query; a field frozen at a phantom 0 costs correctness.
  if (Number.isFinite(value) && value !== 0) ValueCache.set(field, value);
  return value;
};
