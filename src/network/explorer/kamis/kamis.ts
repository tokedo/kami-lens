/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/explorer/kamis/kamis.ts
 * changes:  none
 */

import { EntityIndex, getEntitiesWithValue, World } from 'engine/recs';

import { Components } from 'network/';
import {
  getAllKamis,
  getKami,
  getKamiByIndex,
  getKamiByName,
  KamiOptions,
} from 'network/shapes/Kami';
import { calcKamiScores, calcRarityScores } from './scores';

export const kamis = (world: World, components: Components) => {
  const { EntityType } = components;
  return {
    all: (options?: KamiOptions) => getAllKamis(world, components, options),
    get: (entity: EntityIndex, options?: KamiOptions) =>
      getKami(world, components, entity, options),
    getByIndex: (index: number, options?: KamiOptions) =>
      getKamiByIndex(world, components, index, options),
    getByName: (name: string, options?: KamiOptions) =>
      getKamiByName(world, components, name, options),
    entities: () => Array.from(getEntitiesWithValue(EntityType, { value: 'KAMI' })),
    indices: () => Array.from(components.KamiIndex.values.value.values()),
    scores: {
      rarity: (indices: number[]) => calcRarityScores(world, components, indices),
      overall: (indices: number[]) => calcKamiScores(world, components, indices),
    },
  };
};
