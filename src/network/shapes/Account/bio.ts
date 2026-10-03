/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/network/shapes/Account/bio.ts
 * changes:  none
 */

import { EntityIndex, getComponentValue } from 'engine/recs';

import { Components } from 'network/components';

export const getBio = (components: Components, entity: EntityIndex): string => {
  const { Description } = components;
  return (getComponentValue(Description, entity)?.value as string) ?? '';
};
