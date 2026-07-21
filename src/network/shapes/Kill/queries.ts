/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Kill/queries.ts
 * changes:  two @ts-expect-error — upstream defect at the pin (vite never
 *           typechecks): both queries destructure `IsKill` from Components,
 *           but no IsKill component is registered anywhere upstream (phantom,
 *           like 'network/comps'). These ECS kill queries are dead code at
 *           the pin — the kill feed is served via Kamiden (app/cache/battles);
 *           calling them would throw on Has(undefined) upstream and here
 *           alike. Bodies otherwise verbatim.
 */

import { EntityIndex, Has, HasValue, runQuery, World } from 'engine/recs';

import { Components } from 'network/';

// query KillLog entities by a killer Kami entity
export const queryForKiller = (
  world: World,
  components: Components,
  entity: EntityIndex
): EntityIndex[] => {
  if (!entity) return [];
  // @ts-expect-error upstream defect at the pin: IsKill is never registered
  const { IsKill, SourceID } = components;
  const id = world.entities[entity];
  return Array.from(runQuery([HasValue(SourceID, { value: id }), Has(IsKill)]));
};

// query KillLog entities by a victim Kami entity
export const queryForVictim = (
  world: World,
  components: Components,
  entity: EntityIndex
): EntityIndex[] => {
  if (!entity) return [];
  // @ts-expect-error upstream defect at the pin: IsKill is never registered
  const { IsKill, TargetID } = components;
  const id = world.entities[entity];
  return Array.from(runQuery([HasValue(TargetID, { value: id }), Has(IsKill)]));
};
