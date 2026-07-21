/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/clients/kamiden/subscriptions.ts
 * changes:  import path only ('./proto' — upstream imports the same module
 *           via the same relative path; body verbatim). Note: the daemon's
 *           stream supervisor (src/kamiden.ts) dispatches Feed frames to
 *           FeedCallbacks exactly as upstream's setupSubscription does, but
 *           never dispatches Message frames to MessageCallbacks — stream
 *           chat is dropped at ingestion (DESIGN §3.10). The registry and
 *           subscribeToMessages stay exported for library consumers wiring
 *           their own sources; the daemon simply never feeds them.
 */

import { Feed, Message } from './proto';

type FeedCallback = (feed: Feed) => void;
type MessageCallback = (message: Message) => void;

export const FeedCallbacks: FeedCallback[] = [];
export const MessageCallbacks: MessageCallback[] = [];

export function subscribeToMessages(callback: MessageCallback) {
  MessageCallbacks.push(callback);
  const cleanup = () => {
    const index = MessageCallbacks.indexOf(callback);
    if (index > -1) MessageCallbacks.splice(index, 1);
  };
  return cleanup;
}

export function subscribeToFeed(callback: FeedCallback) {
  FeedCallbacks.push(callback);
  const cleanup = () => {
    const index = FeedCallbacks.indexOf(callback);
    if (index > -1) FeedCallbacks.splice(index, 1);
  };
  return cleanup;
}
