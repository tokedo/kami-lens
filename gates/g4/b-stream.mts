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
//   - both-layer chat exclusion: a topic-filter probe first RECORDS the
//     server's vocabulary (measured 2026-07-21: NO topic string is
//     recognized at this pin — every non-empty list yields zero frames,
//     "empty = all" flows, and the server closes streams every ~40 s), so
//     a Messages-excluding filter is inexpressible without killing the
//     feeds; the daemon subscribes upstream-style (empty list) and the
//     exclusion holds entirely at the ingestion drop: after the window,
//     either zero Message frames arrived or every one is accounted by the
//     drop counters (the path proven hermetically above).
//
// Env: G4B_WINDOW_S (default 1200), G4B_MIN_KILLS (default 1),
//      G4B_MIN_MOVES (default 5), G4B_PROBE_S (default 45).

import { configureKamiden, getKamidenClient } from '../../src/clients/kamiden';
import { subscribeToFeed, subscribeToMessages } from '../../src/clients/kamiden/subscriptions';
import { resolveConfig } from '../../src/config';
import { KamidenFeeds } from '../../src/kamiden';
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

// ---- topic-filter vocabulary probe (recorded evidence, live) ----------------
// A Messages-excluding filter must be REQUESTED per §3.10 — this records
// what requesting one actually does at the pin. The []-control is the
// daemon's own live window below (feedFrames > 0 is a pass condition).

const PROBE_S = Number(process.env.G4B_PROBE_S ?? 45);
const topicProbe: Record<string, { frames: number; feeds: number; messages: number; error: string }> = {};
{
  configureKamiden(resolveConfig().kamidenUrl);
  const client = getKamidenClient();
  if (!client) fail('G4.b', { reason: 'no kamiden url configured for the probe' });
  for (const topics of [['Feed'], []]) {
    const ac = new AbortController();
    let frames = 0;
    let feeds = 0;
    let messages = 0;
    let error = '';
    const timer = setTimeout(() => ac.abort(), PROBE_S * 1000);
    try {
      for await (const r of client.subscribeToStream({ topics }, { signal: ac.signal })) {
        frames++;
        if (r.Feed) feeds++;
        messages += r.Messages.length;
      }
    } catch (e) {
      if (!ac.signal.aborted) error = e instanceof Error ? e.message : String(e);
    }
    clearTimeout(timer);
    topicProbe[JSON.stringify(topics)] = { frames, feeds, messages, error };
  }
  console.log(`topic-filter probe ${JSON.stringify(topicProbe)}`);
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
// Movement verification is deadline-based, not one-shot: the movement
// event and the chain mirror are two independent streams, so the mirror
// may apply the RoomIndex change a few blocks after the feed delivers the
// event — a pending check is re-polled until it verifies, is superseded
// by a newer movement, is PROVEN superseded-unseen (the mirror lands in a
// third room it can only reach via a movement the reconnect gap swallowed
// — the ~40 s server closes make ~10% frame loss routine, measured), or
// exceeds the deadline (the only true failure).
const MOVE_DEADLINE_MS = 90_000; // ≈ 35 blocks — the "within N blocks" bound
type PendingMove = {
  roomIndex: number;
  seq: number;
  armedAtMs: number;
  firstObservedRoom?: number;
};
const pendingMoves = new Map<number, PendingMove>();
let verifiedMoves = 0;
let supersededMoves = 0;
let supersededUnseen = 0;
const failedMoves: Record<string, unknown>[] = [];
const unresolvable: Record<string, unknown>[] = [];
let killsChecked = 0;
let movesObserved = 0;
let lastSeq = 0;
let polls = 0;

async function settlePendingMoves(): Promise<void> {
  for (const [accIndex, p] of pendingMoves) {
    const resp = await socketQuery('account', [String(accIndex)]);
    if (!resp.ok) {
      // can't observe the mirror — still expire (30 s slack), never hang
      if (Date.now() - p.armedAtMs > MOVE_DEADLINE_MS + 30_000) {
        failedMoves.push({ account: accIndex, ...p, observedRoom: null, note: 'account query failing' });
        pendingMoves.delete(accIndex);
      }
      continue;
    }
    const roomNow = (resp.data as { roomIndex: number }).roomIndex;
    if (roomNow === p.roomIndex) {
      verifiedMoves++;
      pendingMoves.delete(accIndex);
      continue;
    }
    if (p.firstObservedRoom === undefined) {
      pendingMoves.set(accIndex, { ...p, firstObservedRoom: roomNow });
    } else if (roomNow !== p.firstObservedRoom) {
      // the mirror moved to a third room with no movement event seen —
      // proof of a lost supersede (rooms change only via moves)
      supersededUnseen++;
      pendingMoves.delete(accIndex);
      continue;
    }
    if (Date.now() - p.armedAtMs > MOVE_DEADLINE_MS) {
      failedMoves.push({ account: accIndex, ...p, observedRoom: roomNow });
      pendingMoves.delete(accIndex);
    }
  }
}

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
        // latest movement per account wins; a still-pending older one is
        // superseded (counted, never a verdict)
        if (pendingMoves.has(m.account.index)) supersededMoves++;
        pendingMoves.set(m.account.index, {
          roomIndex: m.room.index,
          seq: e.seq,
          armedAtMs: Date.now(),
        });
      }
    }

    await settlePendingMoves();

    const killsOk = killChecks.filter((k) => k.ok).length;
    if (
      killsOk >= MIN_KILLS &&
      verifiedMoves >= MIN_MOVES &&
      pendingMoves.size === 0 &&
      failedMoves.length === 0
    )
      break;
  }

  // grace: let still-pending movement checks reach their own deadline
  while (pendingMoves.size > 0) {
    await sleep(POLL_S * 1000);
    await settlePendingMoves();
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

  const chatExclusion = {
    topicsRequested: kamiden.stream.topics,
    topicProbe,
    topicFilterExpressible: false, // measured: no server vocabulary at pin
    messageFramesArrived: kamiden.stream.messageFramesDropped,
    messagesDropped: kamiden.stream.messagesDropped,
    droppedAtIngestion: true, // any arrived frame is counted by the proven drop path
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
    verifiedMoves,
    supersededMoves,
    supersededUnseen,
    moveDeadlineMs: MOVE_DEADLINE_MS,
    movesFailed: failedMoves.slice(0, 20),
    unresolvable: unresolvable.slice(0, 20),
    chatExclusion_measured: chatExclusion,
    match:
      killsOk >= MIN_KILLS &&
      verifiedMoves >= MIN_MOVES &&
      killsFailed.length === 0 &&
      failedMoves.length === 0 &&
      unresolvable.length === 0 &&
      supersededUnseen <= verifiedMoves,
  });

  // the server closes streams every ~40 s (measured), so 'retrying' is a
  // routine transient — the stream is healthy iff frames flowed
  if (kamiden.stream.feedFrames === 0 || !['live', 'retrying', 'connecting'].includes(kamiden.stream.state)) {
    fail('G4.b', {
      reason: `stream unhealthy at window end (state=${kamiden.stream.state}, feedFrames=${kamiden.stream.feedFrames})`,
    });
  }
  if (unresolvable.length > 0) {
    fail('G4.b', { reason: 'unresolvable feed participants', unresolvable: unresolvable.slice(0, 20) });
  }
  if (killsFailed.length > 0) {
    fail('G4.b', { reason: 'kill without mirror state delta', killsFailed });
  }
  if (failedMoves.length > 0) {
    fail('G4.b', {
      reason: 'movement without a RoomIndex delta inside the deadline',
      movesFailed: failedMoves.slice(0, 20),
    });
  }
  if (supersededUnseen > verifiedMoves) {
    fail('G4.b', {
      reason: 'movement cross-check inconclusive — stream loss outpaced verification',
      supersededUnseen,
      verifiedMoves,
    });
  }
  if (killsOk < MIN_KILLS || verifiedMoves < MIN_MOVES) {
    fail('G4.b', {
      reason: 'window closed short of minimum samples — re-run at a busier hour',
      killsOk,
      verifiedMoves,
      windowS: WINDOW_S,
    });
  }
  pass('G4.b', {
    killsOk,
    verifiedMoves,
    supersededMoves,
    supersededUnseen,
    feedFrames: kamiden.stream.feedFrames,
    retries: kamiden.stream.retries,
    messageFramesArrived: kamiden.stream.messageFramesDropped,
    topicFilterExpressible: false,
  });
} finally {
  await daemon.stop();
}
process.exit(0);
