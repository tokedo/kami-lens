/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Portal/queries.ts
 * changes:  none
 */

import { EntityID, EntityIndex, HasValue, QueryFragment, runQuery } from 'engine/recs';
import { Components } from 'network/';

export type QueryOptions = {
  accountID?: EntityID;
};

export const query = (components: Components, options?: QueryOptions): EntityIndex[] => {
  const { EntityType, OwnsWithdrawalID } = components;
  const toQuery: QueryFragment[] = [];

  if (options?.accountID != undefined) {
    toQuery.push(HasValue(OwnsWithdrawalID, { value: options.accountID }));
  } else {
    // if accountID, already filtered by OwnsWithdrawalID
    toQuery.push(HasValue(EntityType, { value: 'TOKEN_RECEIPT' }));
  }

  const results = runQuery(toQuery);
  return Array.from(results);
};

export const queryByAccount = (components: Components, accountID: EntityID): EntityIndex[] => {
  return query(components, { accountID });
};
