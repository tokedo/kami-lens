/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/app/cache/npc/base.ts
 * changes:  Date.now() → clock.monotonicMs() at 1 call site plus the
 *           clock import. The value only ever stamps and ages CACHE
 *           FRESHNESS, so it is read from a clock that cannot go backwards
 *           (1.0.0, A1 — src/clock.ts monotonicMs). 0.2–0.6 read the
 *           offset-corrected projection clock here, which steps backwards on
 *           a re-anchor and then skipped every forced refresh until it caught
 *           up again. Body otherwise verbatim.
 */

import * as clock from 'clock';
import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/components';
import { getNPC, getNPCListings, NPC, NullNPC, queryNPCByIndex } from 'network/shapes/Npc';

export const NpcCache = new Map<EntityIndex, NPC>(); // npc entity -> npc

export const ListingUpdateTs = new Map<EntityIndex, number>(); // last update of the listings

// raw process an NPC entity and set it in the cache
export const process = (world: World, comps: Components, entity: EntityIndex) => {
  const npc = getNPC(world, comps, entity);
  if (npc.index != 0) NpcCache.set(entity, npc);
  return npc;
};

export interface Options {
  listings: number;
}

// get an NPC Object from the cache and refresh its subobjects as requested
export const get = (
  world: World,
  comps: Components,
  entity: EntityIndex,
  options?: Options
): NPC => {
  if (entity == 0) return NullNPC;
  if (!NpcCache.has(entity)) process(world, comps, entity);
  const npc = NpcCache.get(entity) ?? NullNPC;
  if (npc.index == 0 || !options) return npc;

  const now = clock.monotonicMs();

  // populate the listings as requested
  if (options.listings !== undefined) {
    const updateTs = ListingUpdateTs.get(entity) ?? 0;
    const updateDelta = (now - updateTs) / 1000; // convert to seconds
    if (updateDelta > options.listings) {
      npc.listings = getNPCListings(world, comps, npc.index);
      ListingUpdateTs.set(entity, now);
    }
  }

  return npc;
};

// get an NPC Object from the cache by its Index
export const getByIndex = (world: World, comps: Components, index: number, options?: Options) => {
  const entity = queryNPCByIndex(world, comps, index);
  if (!entity) return NullNPC;
  return get(world, comps, entity, options);
};
