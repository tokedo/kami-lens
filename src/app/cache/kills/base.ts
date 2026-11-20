/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
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
