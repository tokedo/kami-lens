/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/app/cache/bonus/getters.ts
 * changes:  Date.now() → clock.monotonicMs() at 1 call site plus the
 *           clock import. The value only ever stamps and ages CACHE
 *           FRESHNESS, so it is read from a clock that cannot go backwards
 *           (1.0.0, A1 — src/clock.ts monotonicMs). 0.2–0.6 read the
 *           offset-corrected projection clock here, which steps backwards on
 *           a re-anchor and then skipped every forced refresh until it caught
 *           up again. Body otherwise verbatim.
 */

import * as clock from 'clock';
import { EntityID, EntityIndex, World } from 'engine/recs';

import { Components } from 'network/';
import { BonusInstance, genBonusEndAnchor, queryBonusForParent } from 'network/shapes/Bonus';
import { getInstance } from './base';

const AnchorToInstances = new Map<EntityID, EntityIndex[]>();

const QueryUpdateTs = new Map<EntityID, number>();

// End types that are queried for temp bonuses
const TEMP_BONUS_END_TYPES = [
  'UPON_HARVEST_ACTION',
  'UPON_LIQUIDATION',
  'UPON_DEATH',
  'UPON_KILL_OR_KILLED',
] as const;

// Invalidate the temp bonuses query cache for a specific holder entity.
// Call this after actions that add/remove bonuses on a Kami (e.g., cast items)
// so the next getTempBonuses call will query fresh data.
export const invalidateTempBonusesCache = (world: World, holder: EntityIndex) => {
  const holderID = world.entities[holder];
  for (const endType of TEMP_BONUS_END_TYPES) {
    const queryID = genBonusEndAnchor(endType, holderID);
    QueryUpdateTs.delete(queryID);
    AnchorToInstances.delete(queryID);
  }
};

const EQUIPMENT_SLOTS = ['Head_Slot', 'Body_Slot', 'Hands_Slot', 'Passport_slot', 'Kami_Pet_Slot'];

export const getTemp = (
  world: World,
  components: Components,
  holder: EntityIndex,
  update: number,
  equipmentOnly?: boolean
) => {
  // todo: add SOURCE to bonus shape. queries based on end type for now
  const equipmentBonuses = EQUIPMENT_SLOTS.flatMap((slot) =>
    getForEndType(world, components, `UPON_UNEQUIP_${slot}`, holder, update)
  );

  if (equipmentOnly) return equipmentBonuses;

  return [
    ...getForEndType(world, components, 'UPON_HARVEST_ACTION', holder, update),
    ...getForEndType(world, components, 'UPON_COOLDOWN_SET', holder, update),
    ...getForEndType(world, components, 'UPON_LIQUIDATION', holder, update),
    ...getForEndType(world, components, 'UPON_DEATH', holder, update),
    ...getForEndType(world, components, 'UPON_KILL_OR_KILLED', holder, update),
    ...equipmentBonuses,
  ];
};

export const getForEndType = (
  world: World,
  components: Components,
  endType: string,
  holder: EntityIndex,
  update: number
): BonusInstance[] => {
  const holderID = world.entities[holder];
  const queryID = genBonusEndAnchor(endType, holderID);
  const instances = queryByParent(components, queryID, update);
  return instances.map((instance) => ({
    ...getInstance(world, components, instance),
    endType,
  }));
};

const queryByParent = (
  components: Components,
  queryID: EntityID,
  update: number
): EntityIndex[] => {
  const now = clock.monotonicMs();
  const updateTs = QueryUpdateTs.get(queryID) ?? 0;
  const updateDelta = (now - updateTs) / 1000;
  if (updateDelta > update) {
    QueryUpdateTs.set(queryID, now);
    // todo? global query retrieval similar to components.ts?
    AnchorToInstances.set(queryID, queryBonusForParent(components, queryID));
  }
  return AnchorToInstances.get(queryID) ?? [];
};
