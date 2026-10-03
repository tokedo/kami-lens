/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
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
