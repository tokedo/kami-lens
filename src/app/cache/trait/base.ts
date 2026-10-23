/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/app/cache/trait/base.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { getTrait as getTraitShape, Trait } from 'network/shapes/Trait';

// cache for trait registry. doesnt ever change, assume stable once retrieved
const TraitCache = new Map<EntityIndex, Trait>(); // trait registry entity -> trait

// get the trait for a kami entity
export const get = (world: World, components: Components, entity: EntityIndex) => {
  if (!TraitCache.has(entity)) process(world, components, entity);
  return TraitCache.get(entity)!;
};

// retrieve a trait's most recent data and update it on the cache
export const process = (world: World, components: Components, entity: EntityIndex) => {
  const trait = getTraitShape(world, components, entity);
  TraitCache.set(entity, trait);
  return trait;
};
