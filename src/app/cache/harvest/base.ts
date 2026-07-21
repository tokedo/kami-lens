/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/app/cache/harvest/base.ts
 * changes:  Date.now() → clock.now() at 1 call site plus the
 *           clock import (§3.8: offset-corrected stream clock, not naive
 *           wall clock — see src/clock.ts). Body otherwise verbatim.
 */

import * as clock from 'clock';
import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { Harvest, getHarvest } from 'network/shapes/Harvest';
import {
  getLastTime,
  getResetTime,
  getStartTime,
  getState,
  getValue,
} from 'network/shapes/utils/component';
import { getKami } from '../kami';
import { getHarvestNode } from './getters';

export const HarvestCache = new Map<EntityIndex, Harvest>();
export const HarvestLastTs = new Map<EntityIndex, number>();
export const RateCache = new Map<EntityIndex, number>(); // harvest entity -> rate

// last updates of sub-objects
export const KamiUpdateTs = new Map<EntityIndex, number>();
export const NodeUpdateTs = new Map<EntityIndex, number>();

interface Options {
  live?: number;
  node?: number; // consider removing this as an option to flatten shape
  kami?: number; // consider removing this as an option to flatten shape
}
// get a harvest from the cache or poll the live data
export const get = (world: World, comps: Components, entity: EntityIndex, options?: Options) => {
  if (!HarvestLastTs.has(entity)) process(world, comps, entity);
  const harvest = HarvestCache.get(entity)!;
  if (!options) return harvest;

  const now = clock.now();

  // populate the live changing fields
  if (options.live != undefined) {
    const updateTs = HarvestLastTs.get(entity) ?? 0;
    const updateDelta = (now - updateTs) / 1000; // convert to seconds
    if (updateDelta > options.live) {
      harvest.balance = getValue(comps, entity);
      harvest.state = getState(comps, entity);
      harvest.time = {
        start: getStartTime(comps, entity),
        reset: getResetTime(comps, entity),
        last: getLastTime(comps, entity),
      };
    }
  }

  // populate the kami if requested
  if (options.kami != undefined) {
    const updateTs = KamiUpdateTs.get(entity) ?? 0;
    const updateDelta = (now - updateTs) / 1000; // convert to seconds
    if (updateDelta > options.kami) {
      harvest.kami = getKami(world, comps, entity, options);
      KamiUpdateTs.set(entity, now);
    }
  }

  // populate the node if requested
  if (options.node != undefined) {
    const updateTs = NodeUpdateTs.get(entity) ?? 0;
    const updateDelta = (now - updateTs) / 1000; // convert to seconds
    if (updateDelta > options.node) {
      harvest.node = getHarvestNode(world, comps, entity);
      NodeUpdateTs.set(entity, now);
    }
  }

  return harvest;
};

// retrieve a harvest's most recent data and update it on the cache
export const process = (world: World, comps: Components, entity: EntityIndex) => {
  const harvest = getHarvest(world, comps, entity);
  HarvestLastTs.set(entity, harvest.time.last);
  HarvestCache.set(entity, harvest);
  return harvest;
};
