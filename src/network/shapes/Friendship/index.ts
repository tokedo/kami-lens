/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
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
