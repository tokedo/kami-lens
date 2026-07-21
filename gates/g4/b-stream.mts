// Gate G4.b [live + hermetic] — stream feed cross-check.
//
// Hermetic part (runs first, no network): a StreamResponse carrying
// Messages and a Feed is pushed through KamidenFeeds' EXACT ingestion path
// (ingestForTest → the same private method the live loop calls). Proves:
// Message frames are dropped and counted, MessageCallbacks is NEVER
// invoked by the daemon, Feed frames dispatch to FeedCallbacks, and the
// ring buffer flattens/sequences/evicts correctly. This is the "drop must
// be proven to work when the transport promise fails" clause — the drop
// holds even if the topic filter delivers chat.
//
// Live part: warm daemon, then a polling window over the `feed` query:
//   - sampled Kill events must have mirror-resolvable participants
//     (killer/victim/account joins carry an index) and a corresponding
//     mirror state delta within N blocks: the victim, queried promptly
//     over the same socket, is no longer HARVESTING (a liquidation ends
//     the victim's harvest; one 15 s re-check absorbs stream lag).
//   - Movements are cross-checked against RoomIndex changes: the moved
//     account's `account` answer must show the movement's room, where a
//     newer movement for the same account supersedes the check.
//   - both-layer chat exclusion: the subscription runs with the
//     Messages-excluding topic filter; after the window, either zero
//     Message frames arrived (filter effective — recorded) or every one
//     is accounted by the ingestion-drop counters (proven above). The
//     topic filter's live behavior is a MEASUREMENT (server semantics are
//     unverifiable at the pin).
//
// Env: G4B_WINDOW_S (default 1200), G4B_MIN_KILLS (default 1),
//      G4B_MIN_MOVES (default 5).

import { KamidenFeeds } from '../../src/kamiden';
import { subscribeToFeed, subscribeToMessages } from '../../src/clients/kamiden/subscriptions';
import { fail, pass, sleep, writeMeasurement } from '../g1/lib.mts';
import { socketQuery, spawnDaemonLive } from './lib.mts';

// ---- hermetic: ingestion drop + ring buffer ---------------------------------

{
  const feeds = new KamidenFeeds({ url: 'http://unused.invalid', bufferCapacity: 3 });
  let feedCbCount = 0;
  let messageCbCount = 0;
  const offFeed = subscribeToFeed(() => feedCbCount++);
  const offMsg = subscribeToMessages(() => messageCbCount++);

  const emptyFeed = {
    Movements: [],
    HarvestEnds: [],
    Kills: [],
    Trades: [],
    KamiCasts: [],
    DroptableReveals: [],
    SacrificeReveals: [],
    KamiMarketLists: [],
    KamiMarketBuys: [],
    KamiMarketOffers: [],
    KamiMarketAccepts: [],
    KamiMarketCancels: [],
  };
  const msg = { RoomIndex: 1, AccountId: '123', Message: 'DROP-ME', Timestamp: 1 };
  const move = (n: number) => ({ RoomIndex: n, AccountId: String(n), Timestamp: n });

  // frame 1: two chat messages + a feed with one movement
  feeds.ingestForTest({
    Messages: [msg, msg],
    Feed: { ...emptyFeed, Movements: [move(1)] },
  });
  // frame 2: chat only — must be a pure drop, no feed dispatch
  feeds.ingestForTest({ Messages: [msg], Feed: undefined });
  // frames 3-5: enough movements to overflow the capacity-3 buffer
  feeds.ingestForTest({ Messages: [], Feed: { ...emptyFeed, Movements: [move(2), move(3)] } });
  feeds.ingestForTest({ Messages: [], Feed: { ...emptyFeed, Movements: [move(4)] } });

  const s = feeds.getStatus();
  const buffered = feeds.read({});
  const checks = {
    messageFramesDropped: s.stream.messageFramesDropped === 2,
    messagesDropped: s.stream.messagesDropped === 3,
    messageCallbacksNeverInvoked: messageCbCount === 0,
    feedCallbacksInvoked: feedCbCount === 3,
    framesCounted: s.stream.framesReceived === 4,
    bufferEvicted: s.buffer.evicted === 1 && s.buffer.size === 3,
    bufferSequence:
      buffered.map((e) => e.seq).join(',') === '2,3,4' &&
      buffered.every((e) => e.type === 'movement'),
    eventCounters: s.stream.events.movement === 4,
  };
  feeds.stop();
  offFeed();
  offMsg();
  if (!Object.values(checks).every(Boolean)) {
    fail('G4.b', { reason: 'hermetic ingestion-drop/buffer checks failed', checks });
  }
  console.log(`hermetic ingestion checks OK ${JSON.stringify(checks)}`);
}

// ---- live: window over the feed query ---------------------------------------

const WINDOW_S = Number(process.env.G4B_WINDOW_S ?? 1200);
const MIN_KILLS = Number(process.env.G4B_MIN_KILLS ?? 1);
const MIN_MOVES = Number(process.env.G4B_MIN_MOVES ?? 5);
const POLL_S = 5;

type IdRef = { id: string; index?: number; name?: string };
type FeedEntry = {
  seq: number;
  type: string;
  kill?: { killer: IdRef; victim: IdRef; account: IdRef; isDeath: boolean; roomIndex: number };
  movement?: { account: IdRef; room: { index: number }; timestamp: number };
};

const daemon = await spawnDaemonLive();
const killChecks: Record<string, unknown>[] = [];
const moveChecks = new Map<
  number,
  { roomIndex: number; seq: number; ok: boolean | null; observedRoom?: number }
>();
const unresolvable: Record<string, unknown>[] = [];
let killsChecked = 0;
let movesObserved = 0;
let lastSeq = 0;
let polls = 0;

try {
  const deadline = Date.now() + WINDOW_S * 1000;
  while (Date.now() < deadline) {
    await sleep(POLL_S * 1000);
    polls++;
    const resp = await socketQuery('feed', [String(lastSeq)]);
    if (!resp.ok) fail('G4.b', { reason: 'feed query failed', error: resp.error });
    const data = resp.data as { events: FeedEntry[]; stream: { state: string } };
    const events = data.events;
    if (events.length > 0) lastSeq = Math.max(...events.map((e) => e.seq));

    for (const e of events) {
      if (e.type === 'kill' && e.kill) {
        const k = e.kill;
        if (k.killer.index === undefined || k.victim.index === undefined) {
          unresolvable.push({ where: 'kill', killer: k.killer.id, victim: k.victim.id });
          continue;
        }
        // mirror state delta: victim promptly not HARVESTING (retry once)
        let state = '';
        let blockAtCheck = 0;
        for (let attempt = 0; attempt < 2; attempt++) {
          const vk = await socketQuery('kami', [String(k.victim.index)]);
          if (!vk.ok) break;
          state = (vk.data as { state: string }).state;
          blockAtCheck = vk.meta!.blockNumber;
          if (state !== 'HARVESTING') break;
          await sleep(15_000);
        }
        killsChecked++;
        killChecks.push({
          victim: k.victim.index,
          killer: k.killer.index,
          isDeath: k.isDeath,
          stateAfter: state,
          blockAtCheck,
          ok: state !== '' && state !== 'HARVESTING',
        });
      }
      if (e.type === 'movement' && e.movement) {
        movesObserved++;
        const m = e.movement;
        if (m.account.index === undefined) {
          unresolvable.push({ where: 'movement', account: m.account.id });
          continue;
        }
        // latest movement per account wins; each poll re-arms the check
        moveChecks.set(m.account.index, { roomIndex: m.room.index, seq: e.seq, ok: null });
      }
    }

    // verify pending movement checks against the mirror (prompt, same poll)
    for (const [accIndex, check] of moveChecks) {
      if (check.ok !== null) continue;
      const resp2 = await socketQuery('account', [String(accIndex)]);
      if (!resp2.ok) continue;
      const roomNow = (resp2.data as { roomIndex: number }).roomIndex;
      moveChecks.set(accIndex, { ...check, ok: roomNow === check.roomIndex, observedRoom: roomNow });
    }

    const killsOk = killChecks.filter((k) => k.ok).length;
    const movesOk = [...moveChecks.values()].filter((m) => m.ok).length;
    if (killsOk >= MIN_KILLS && movesOk >= MIN_MOVES) break;
  }

  // final status: chat-exclusion accounting + stream health
  const statusResp = await socketQuery('status');
  const kamiden = (statusResp.data as {
    kamiden: {
      stream: {
        state: string;
        topics: string[];
        framesReceived: number;
        feedFrames: number;
        messageFramesDropped: number;
        messagesDropped: number;
        retries: number;
        events: Record<string, number>;
      };
    };
  }).kamiden;

  const killsOk = killChecks.filter((k) => k.ok).length;
  const killsFailed = killChecks.filter((k) => !k.ok);
  const moveResults = [...moveChecks.entries()].map(([acc, m]) => ({ account: acc, ...m }));
  const movesOk = moveResults.filter((m) => m.ok).length;
  const movesFailed = moveResults.filter((m) => m.ok === false);

  const chatExclusion = {
    topics: kamiden.stream.topics,
    messageFramesArrived: kamiden.stream.messageFramesDropped,
    messagesDropped: kamiden.stream.messagesDropped,
    topicFilterEffective: kamiden.stream.messageFramesDropped === 0,
    accounted: true, // any arrived frame is counted by the proven drop path
  };

  await writeMeasurement('g4b-stream', {
    windowS: WINDOW_S,
    polls,
    streamState: kamiden.stream.state,
    framesReceived: kamiden.stream.framesReceived,
    feedFrames: kamiden.stream.feedFrames,
    retries: kamiden.stream.retries,
    eventCounts: kamiden.stream.events,
    killsChecked,
    killsOk,
    killChecks: killChecks.slice(0, 20),
    movesObserved,
    movesChecked: moveResults.length,
    movesOk,
    movesFailed: movesFailed.slice(0, 20),
    unresolvable: unresolvable.slice(0, 20),
    chatExclusion_measured: chatExclusion,
    match:
      killsOk >= MIN_KILLS &&
      movesOk >= MIN_MOVES &&
      killsFailed.length === 0 &&
      movesFailed.length === 0 &&
      unresolvable.length === 0,
  });

  if (kamiden.stream.state !== 'live') {
    fail('G4.b', { reason: `stream not live at window end (${kamiden.stream.state})` });
  }
  if (unresolvable.length > 0) {
    fail('G4.b', { reason: 'unresolvable feed participants', unresolvable: unresolvable.slice(0, 20) });
  }
  if (killsFailed.length > 0) {
    fail('G4.b', { reason: 'kill without mirror state delta', killsFailed });
  }
  if (movesFailed.length > 0) {
    fail('G4.b', { reason: 'movement/RoomIndex mismatches', movesFailed: movesFailed.slice(0, 20) });
  }
  if (killsOk < MIN_KILLS || movesOk < MIN_MOVES) {
    fail('G4.b', {
      reason: 'window closed short of minimum samples — re-run at a busier hour',
      killsOk,
      movesOk,
      windowS: WINDOW_S,
    });
  }
  pass('G4.b', {
    killsOk,
    movesOk,
    feedFrames: kamiden.stream.feedFrames,
    messageFramesArrived: kamiden.stream.messageFramesDropped,
    topicFilterEffective: chatExclusion.topicFilterEffective,
  });
} finally {
  await daemon.stop();
}
process.exit(0);
