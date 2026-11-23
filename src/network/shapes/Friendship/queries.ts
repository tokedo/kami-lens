/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Friendship/queries.ts
 * changes:  none
 */

import { EntityID, EntityIndex, HasValue, QueryFragment, runQuery } from 'engine/recs';

import { Components } from 'network/';
import { FriendState } from './types';

export interface queryOptions {
  account?: EntityID;
  target?: EntityID;
  state?: FriendState;
}

export const query = (comps: Components, options: queryOptions): EntityIndex[] => {
  const { EntityType, SourceID, TargetID, State } = comps;

  const toQuery: QueryFragment[] = [];
  if (options?.account) toQuery.push(HasValue(SourceID, { value: options.account }));
  if (options?.target) toQuery.push(HasValue(TargetID, { value: options.target }));
  if (options?.state) toQuery.push(HasValue(State, { value: options.state }));
  toQuery.push(HasValue(EntityType, { value: 'FRIENDSHIP' }));
  return Array.from(runQuery(toQuery));
};
