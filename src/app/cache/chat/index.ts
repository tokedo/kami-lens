/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/app/cache/chat/index.ts
 * changes:  none
 */

export {
  get as getChat,
  getLastTimestamp as getChatLastTimestamp,
  numMessagesSince as numMessagesChatSince,
  process as processChat,
  push as pushChat,
} from './chat';
