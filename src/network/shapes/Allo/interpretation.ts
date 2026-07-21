/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Allo/interpretation.ts
 * changes:  three @ts-expect-error — upstream type defects at the pin (vite
 *           never typechecks): parseBonus and parseStat return DetailedEntity
 *           objects without the required `entity`, and parseBonus/parseDroptable
 *           use the placeholder png MODULE NAMESPACE (`{ default: url }`), not
 *           a string, as `image` (see assets placeholder shim). Body otherwise
 *           verbatim.
 */

import * as placeholder from 'assets/images/icons/placeholder.png';
import { World } from 'engine/recs';
import { Components } from 'network/components';
import { Allo } from '.';
import { getBonusesByParent, parseBonusText } from '../Bonus';
import { getDTDetails, NullDT } from '../Droptable';
import { parseFlagString } from '../Flag';
import { NullStat } from '../Stats';
import {
  capitalize,
  DetailedEntity,
  getFromDescription,
  getStatImage,
  parseQuantity,
  parseQuantityStat,
  parseStatTypeFromIndex,
} from '../utils';

export const parseAllos = (
  world: World,
  components: Components,
  allos: Allo[],
  flattenDT?: boolean
): DetailedEntity[] => {
  const raw = allos.map((allo) => parseAllo(world, components, allo, flattenDT));
  return raw.flat();
};

export const parseAllo = (
  world: World,
  components: Components,
  allo: Allo,
  flattenDT?: boolean
): DetailedEntity | DetailedEntity[] => {
  if (allo.type === 'BONUS') {
    return parseBonus(world, components, allo);
  } else if (allo.droptable) {
    if (flattenDT) return parseDroptableIndividual(world, components, allo);
    else return parseDroptable(world, components, allo);
  } else if (allo.stat) return parseStat(allo);
  else return parseBasic(world, components, allo);
};

////////////////
// INTERNAL

const parseBasic = (world: World, components: Components, allo: Allo): DetailedEntity => {
  const details = getFromDescription(world, components, allo.type, allo.index);
  let description = '';
  if (allo.type === 'STATE') description = parseState(details);
  else if (allo.type.includes('FLAG_')) {
    description = parseFlag(allo);
  } else description = '+' + parseQuantity(details, allo.value);

  return {
    ...details,
    description,
  };
};

const parseBonus = (world: World, components: Components, allo: Allo): DetailedEntity[] => {
  const bonuses = getBonusesByParent(world, components, allo.id);
  // @ts-expect-error upstream defect at the pin: no `entity`, namespace as image
  return bonuses.map((bonus) => ({
    ObjectType: 'BONUS',
    name: parseBonusText(bonus),
    description: parseBonusText(bonus),
    image: placeholder,
  }));
};

const parseDroptable = (world: World, components: Components, allo: Allo): DetailedEntity => {
  const dt = allo.droptable ?? NullDT;
  const all = getDTDetails(world, components, dt);

  // consolidate individual entries into one
  return {
    ObjectType: 'DROPTABLE',
    // @ts-expect-error upstream defect at the pin: namespace as image
    image: placeholder,
    name: 'Potential drops',
    description: all.map((entry) => `${entry.name} [${entry.description}]`).join('\n'),
  };
};

const parseDroptableIndividual = (
  world: World,
  components: Components,
  allo: Allo
): DetailedEntity[] => {
  const dt = allo.droptable ?? NullDT;
  return getDTDetails(world, components, dt);
};

const parseStat = (allo: Allo): DetailedEntity => {
  const stat = allo.stat ?? NullStat;

  const name = capitalize(parseStatTypeFromIndex(allo.index));
  const quantity = '+' + parseQuantityStat(name, stat);

  // @ts-expect-error upstream defect at the pin: no `entity` on DetailedEntity
  return {
    ObjectType: 'STAT',
    image: getStatImage(name),
    name,
    description: quantity,
  };
};

///////////////
// SPECIFIC CASES

const parseState = (details: DetailedEntity): string => {
  const capsState = details.name.toUpperCase();
  let description = '';
  if (capsState === 'RESTING') description = 'Revive';
  else if (capsState === 'DEAD') description = 'Kill';
  else if (capsState === '721_EXTERNAL') description = 'Send out of this world';
  return description;
};

const parseFlag = (allo: Allo): string => {
  return parseFlagString(allo.type ?? '');
};
