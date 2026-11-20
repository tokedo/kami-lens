/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/network/shapes/Account/bio.ts
 * changes:  none
 */

import { EntityIndex, getComponentValue } from 'engine/recs';

import { Components } from 'network/components';

export const getBio = (components: Components, entity: EntityIndex): string => {
  const { Description } = components;
  return (getComponentValue(Description, entity)?.value as string) ?? '';
};
