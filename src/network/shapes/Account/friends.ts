/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Account/friends.ts
 * changes:  none
 */

import { EntityIndex, World } from 'engine/recs';
import { Components } from 'network/components';
import { getBonusValue } from '../Bonus';
import { getConfigFieldValue } from '../Config';
import {
  Friendship,
  getAccBlocked,
  getAccFriends,
  getAccIncomingRequests,
  getAccOutgoingRequests,
} from '../Friendship';

export interface Friends {
  friends: Friendship[];
  incomingReqs: Friendship[];
  outgoingReqs: Friendship[];
  blocked: Friendship[];
  limits: {
    friends: number;
    requests: number;
  };
}

export const getFriends = (world: World, components: Components, entity: EntityIndex) => {
  const id = world.entities[entity];
  return {
    friends: getAccFriends(world, components, entity, { bio: true }),
    incomingReqs: getAccIncomingRequests(world, components, entity, { bio: true }),
    outgoingReqs: getAccOutgoingRequests(world, components, entity, { bio: true }),
    blocked: getAccBlocked(world, components, entity, { bio: true }),
    limits: {
      friends:
        getConfigFieldValue(world, components, 'BASE_FRIENDS_LIMIT') * 1 +
        (getBonusValue(world, components, 'FRIENDS_LIMIT', id) ?? 0),
      requests: getConfigFieldValue(world, components, 'FRIENDS_REQUEST_LIMIT') * 1,
    },
  };
};
