/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/app/cache/chat/chat.ts
 * changes:  (M4 — deferred from the M2 unit with the rest of the Kamiden
 *           client, DESIGN §3.4/§3.10.) Two documented swaps:
 *           Date.now() → clock.now() at 1 call site (§3.8; Kamiden
 *           timestamps are MILLISECONDS, so clock.now()'s ms fits the
 *           upstream unit exactly), and the module-scope
 *           `const KamidenClient = getKamidenClient()` capture moves
 *           inside process() (swap point 1 — daemon configuration happens
 *           after module import; see app/cache/battles for the same
 *           amendment). Body otherwise verbatim, quirks preserved:
 *           process() paginates BACKWARD from messages[0] (the oldest
 *           held message) and prepends the fetched page, while
 *           getLastTimestamp reads from the array tail.
 *           Daemon wiring note (§3.10): the daemon's chat query is a
 *           GetRoomMessages passthrough and does NOT read or fill this
 *           cache, and push() is never invoked by the daemon (no Messages
 *           stream ingestion — dropped at the supervisor). The cache stays
 *           ported for library consumers using the upstream accumulation
 *           semantics.
 */

import * as clock from 'clock';

import { getKamidenClient, Message } from 'clients/kamiden';

// nodeindex ,messages list
export const ChatCache = new Map<number, Message[]>();

export const get = async (roomIndex: number, append: boolean) => {
  if (!ChatCache.has(roomIndex) || append) await process(roomIndex);
  return ChatCache.get(roomIndex)!;
};

export const process = async (roomIndex: number) => {
  const KamidenClient = getKamidenClient();
  if (!KamidenClient) {
    console.warn('process(): Kamiden client not initialized');
    ChatCache.set(roomIndex, []);
    return;
  }
  const messages: Message[] = ChatCache.get(roomIndex) ?? [];
  const lastTs = messages[0]?.Timestamp ?? clock.now();
  const response = await KamidenClient.getRoomMessages({
    RoomIndex: roomIndex,
    Timestamp: lastTs,
  });
  ChatCache.set(roomIndex, response.Messages.concat(messages));
};

// if the room has been visited before it appends the new message
// if the room has not been visited before it calls the get function (this will populate the cache with the messages of the room )
export const push = (newMessage: Message) => {
  var roomMessages = ChatCache.get(newMessage.RoomIndex);
  if (roomMessages) {
    ChatCache.set(newMessage.RoomIndex, roomMessages.concat(newMessage));
  } else {
    get(newMessage.RoomIndex, false);
  }
};

export const getLastTimestamp = (roomIndex: number) => {
  const messages = ChatCache.get(roomIndex);
  if (!messages) return 0;
  const len = messages.length;
  return messages[len - 1]?.Timestamp ?? 0;
};

export const numMessagesSince = (roomIndex: number, lastTimeStamp: number) => {
  const cacheLength = ChatCache.get(roomIndex)?.length ?? 0;
  const lastVisitedPosition =
    ChatCache.get(roomIndex)?.findIndex((message) => message.Timestamp >= lastTimeStamp) ?? 0;
  const numberNewMessages = cacheLength - lastVisitedPosition;
  return numberNewMessages;
};
