/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/utils/references.ts
 * changes:  none
 */

import { EntityID, EntityIndex, HasValue, runQuery } from 'engine/recs';
import { BigNumberish } from 'ethers';
import { Components } from 'network/';
import { hashArgs } from './IDs';

/////////////////
// QUERIES

export const queryRefsWithParent = (components: Components, anchorID: EntityID): EntityIndex[] => {
  const { AnchorID } = components;
  return Array.from(runQuery([HasValue(AnchorID, { value: anchorID })]));
};

export const queryRefChildren = (
  components: Components,
  field: string,
  anchorID: EntityID,
  key?: BigNumberish
): EntityIndex[] => {
  const { AnchorID } = components;

  const id = genRef(field, anchorID, key);
  return Array.from(runQuery([HasValue(AnchorID, { value: id })]));
};

/////////////////
// UTILS

export const genRef = (field: string, anchorID: EntityID, key?: BigNumberish): EntityID => {
  const args = key
    ? ['reference.instance', field, key, anchorID]
    : ['reference.instance', field, anchorID];
  const argTypes = key
    ? ['string', 'string', 'uint256', 'uint256']
    : ['string', 'string', 'uint256'];
  return hashArgs(args, argTypes);
};
