/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Account/bio.ts
 * changes:  none
 */

import { EntityIndex, getComponentValue } from 'engine/recs';

import { Components } from 'network/components';

export const getBio = (components: Components, entity: EntityIndex): string => {
  const { Description } = components;
  return (getComponentValue(Description, entity)?.value as string) ?? '';
};
