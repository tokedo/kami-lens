/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/network/shapes/Kill/queries.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';

// kills are emitted as world events, not stored as entities, so no KillLog entities exist;
// kill history is served by kamiden (see app/cache/battles)

// query KillLog entities by a killer Kami entity
export const queryForKiller = (
  world: World,
  components: Components,
  entity: EntityIndex
): EntityIndex[] => {
  return [];
};

// query KillLog entities by a victim Kami entity
export const queryForVictim = (
  world: World,
  components: Components,
  entity: EntityIndex
): EntityIndex[] => {
  return [];
};
