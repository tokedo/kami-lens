/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
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
