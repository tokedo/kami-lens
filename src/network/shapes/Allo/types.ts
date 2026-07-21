/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Allo/types.ts
 * changes:  none
 */

import { EntityID, EntityIndex, World } from 'engine/recs';
import { Components } from 'network/';
import { Bonus, getBonusRegistry, queryBonusForParent } from '../Bonus';
import { Droptable, getDroptable } from '../Droptable';
import { Stat, getStatFromUint } from '../Stats';
import { getIndex, getSourceID, getType, getValue } from '../utils/component';

export interface Allo {
  id: EntityID;
  type: string;
  index: number;
  value: number;
  sourceID: string;
  bonuses?: Bonus[];
  droptable?: Droptable;
  stat?: Stat;
}

// Get a Allo Registry object
export const getAllo = (world: World, comps: Components, entity: EntityIndex): Allo => {
  const id = world.entities[entity];
  const type = getType(comps, entity);
  const value = getValue(comps, entity);

  const allo: Allo = {
    id,
    type,
    index: getIndex(comps, entity),
    value,
    sourceID: getSourceID(comps, entity),
  };

  /////////////////
  // OPTIONAL FIELDS

  // if bonus type allo, add bonuses
  if (type.includes('BONUS')) {
    const bonusEntities = queryBonusForParent(comps, id);
    allo.bonuses = bonusEntities.map((e) => getBonusRegistry(world, comps, e));
  }

  // if droptable type allo, add the droptable
  const hasDroptable = type.includes('ITEM_DROPTABLE');
  if (hasDroptable) allo.droptable = getDroptable(comps, entity);

  // if stat type allo, add the stat
  const isStat = type === 'STAT';
  if (isStat) allo.stat = getStatFromUint(BigInt(value));

  return allo;
};
