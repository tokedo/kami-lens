/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/app/cache/kills/base.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { getKill, KillLog } from 'network/shapes/Kill';

export const KillCache = new Map<EntityIndex, KillLog>();

export const get = (world: World, components: Components, entity: EntityIndex) => {
  if (!KillCache.has(entity)) process(world, components, entity);
  return KillCache.get(entity)!;
};

export const process = (world: World, components: Components, entity: EntityIndex) => {
  const kill = getKill(world, components, entity);
  KillCache.set(entity, kill);
};
