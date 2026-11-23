/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/shapes/Friendship/index.ts
 * changes:  none
 */

export {
  getAccBlocked,
  getAccFriends,
  getAccIncomingRequests,
  getAccOutgoingRequests,
} from './getters';
export { query as queryFriends } from './queries';
export { get as getFriendship } from './types';

export type { Friendship } from './types';
