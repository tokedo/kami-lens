// Gate G4.c [live + hermetic] — chat plan conformance (DESIGN §3.10).
//
// Hermetic parts (snapshot mirror + a fixture supervisor standing in for
// the transport — no network):
//   1. oversize withhold-with-receipt: a body over chatMaxBytes is served
//      WITHOUT its message field, with an explicit in-row receipt
//      {reason: 'oversize', bytes}; the --oversize override serves the
//      body verbatim, byte-exact (never truncated); normal bodies ride
//      verbatim either way.
//   2. envelope: every served body is tagged authored-prose in the
//      untrusted list (the dedicated query IS the prose opt-in — no
//      --prose needed); --no-authored withholds joined account names with
//      receipt while bodies stay (prose ≠ id classes).
//   3. kill-switch: ctx.chat.enabled=false → the documented CHAT_DISABLED
//      error, not a silent absence.
//   4. never-in-reports sweep: with a sentinel chat body seeded in the
//      fixture service, EVERY non-chat query is built over the same
//      mirror+supervisor and its full JSON output must not contain the
//      sentinel — chat bodies reach exactly one surface.
//
// Live parts (warm daemon):
//   5. paginated GetRoomMessages passthrough: a busy room's page decodes,
//      validates against the checked-in schema, tags messages[].message,
//      and pages backward (page 2 strictly older, no overlap).
//   6. live never-in-reports: every body fetched in 5 is absent from the
//      live status/feed/market/node/items outputs.
//   7. config kill-switch, live: a second daemon cycle with
//      KAMI_LENS_CHAT_ENABLED=false answers chat with CHAT_DISABLED while
//      chain queries still serve.

import path from 'node:path';

import Ajv from 'ajv/dist/2020';

import { resolveConfig } from '../../src/config';
import type { KamidenFeeds } from '../../src/kamiden';
import { serveQuery, QueryError } from '../../src/queries';
import { loadSchema, QUERY_NAMES } from '../../src/queries/registry';
import { query as queryKamis } from '../../src/network/shapes/Kami/queries';
import { getKamiIndex } from '../../src/network/shapes/utils/component';
import { ARTIFACTS_DIR, fail, loadCacheFromSnapshotFile, pass, writeMeasurement } from '../g1/lib.mts';
import { buildMirror } from '../g2/lib.mts';
import { socketQuery, spawnDaemonLive } from './lib.mts';

const ajv = new Ajv({ strict: true, allErrors: true });
ajv.addSchema(loadSchema('chat'), 'chat');

// ---- hermetic fixture world -------------------------------------------------

const config = resolveConfig();
const cache = await loadCacheFromSnapshotFile(path.join(ARTIFACTS_DIR, 'c2.v8snap'), config);
const { world, components } = buildMirror(cache);
const mirror = { world, components, blockNumber: cache.blockNumber };

// a real account id from the mirror (join realism) — via a kami's owner
let realAccountId = '';
for (const e of queryKamis(components).slice(0, 200)) {
  const idx = getKamiIndex(components, e);
  if (!idx) continue;
  const resp = await serveQuery(mirror, 'kami', [String(idx)], { stale: false, mode: 'daemon' });
  const acc = (resp.data as { account?: { index: number } }).account;
  if (acc?.index) {
    const accResp = await serveQuery(mirror, 'account', [String(acc.index)], { stale: false, mode: 'daemon' });
    realAccountId = BigInt((accResp.data as { id: string }).id).toString();
    break;
  }
}
if (!realAccountId) fail('G4.c', { reason: 'no resolvable account in the snapshot mirror' });

const SENTINEL = 'G4C-SENTINEL-BODY-b64897c1-never-in-reports';
const OVERSIZE_BODY = 'X'.repeat(300) + SENTINEL;
const NORMAL_BODY = 'gm from the gate fixture';

const fixtureMessages = [
  { RoomIndex: 7, AccountId: realAccountId, Message: OVERSIZE_BODY, Timestamp: 1_753_000_000_000 },
  { RoomIndex: 7, AccountId: realAccountId, Message: NORMAL_BODY, Timestamp: 1_753_000_100_000 },
  { RoomIndex: 7, AccountId: '999999999999', Message: NORMAL_BODY, Timestamp: 1_753_000_200_000 },
];

// fixture supervisor: the unary surface only — returns canned responses
// for every method a builder can call (sentinel appears ONLY in chat)
const fixtureKamiden = {
  unary: async (method: string, invoke: unknown) => {
    void invoke;
    switch (method) {
      case 'GetRoomMessages':
        return { Messages: fixtureMessages, Feeds: [] };
      case 'GetBattleStats':
        return { BattleStats: { Kills: 1, Deaths: 0, PNL: 5 } };
      case 'GetBattles':
        return { Kills: [] };
      case 'GetTradeHistory':
      case 'GetOpenOffers':
        return { Trades: [] };
      case 'GetKamiMarketListings':
        return { Listings: [] };
      case 'GetKamiMarketBids':
        return { Bids: [] };
      case 'GetKamiMarketHistory':
        return { Orders: [] };
      case 'GetTokenDeposits':
      case 'GetTokenWithdrawals':
      case 'GetOpenWithdrawals':
        return { Receipts: [] };
      case 'GetItemTransfers':
        return { Transfers: [] };
      case 'GetAuctionBuys':
        return { AuctionBuys: [] };
      case 'GetKillsByKami':
        // 0.2.0 killers passthrough — plain rows; the sentinel appears
        // ONLY in chat (the sweep's leak premise)
        return { Rows: [{ Name: 'Fixture Killer', Value: '3' }, { Name: 'K2', Value: '1' }] };
      default:
        throw new Error(`fixture has no response for ${method}`);
    }
  },
  read: () => [],
  getStatus: () => ({
    configured: true,
    url: 'fixture',
    stream: {
      state: 'stopped',
      topics: ['Feed'],
      startedAt: null,
      framesReceived: 0,
      feedFrames: 0,
      lastFrameAtWallMs: 0,
      silentMs: 0,
      messageFramesDropped: 0,
      messagesDropped: 0,
      retries: 0,
      consecutiveFailures: 0,
      lastError: null,
      events: {},
    },
    buffer: { size: 0, capacity: 4096, evicted: 0, newestSeq: 0 },
    unary: {},
  }),
} as unknown as KamidenFeeds;

const MAX_BYTES = 128; // fixture threshold: NORMAL under, OVERSIZE over
const ctx = { mirror, kamiden: fixtureKamiden, chat: { enabled: true, maxBytes: MAX_BYTES } };

type ChatData = {
  messages: {
    account: { id: string; index?: number; name?: string };
    message?: string;
    withheld?: { reason: string; bytes: number };
  }[];
};

// 1. + 2. oversize withhold + envelope tagging
const page = await serveQuery(ctx, 'chat', ['7'], { stale: false, mode: 'daemon' });
const pageData = page.data as ChatData;
const oversizeRow = pageData.messages[0];
const normalRow = pageData.messages[1];
const bareRow = pageData.messages[2];
const expectedBytes = Buffer.byteLength(OVERSIZE_BODY, 'utf8');
const hermeticChecks: Record<string, boolean> = {
  schemaValid: ajv.validate('chat', page.data) as boolean,
  oversizeWithheld:
    oversizeRow.message === undefined &&
    oversizeRow.withheld?.reason === 'oversize' &&
    oversizeRow.withheld?.bytes === expectedBytes,
  normalVerbatim: normalRow.message === NORMAL_BODY && normalRow.withheld === undefined,
  accountJoined: normalRow.account.index !== undefined && normalRow.account.name !== undefined,
  unresolvableBare: bareRow.account.index === undefined && bareRow.account.id === '999999999999',
  bodiesTagged: page.untrusted.includes('messages[].message'),
  namesTagged: page.untrusted.includes('messages[].account.name'),
};

// --oversize override: byte-exact verbatim
const rawPage = await serveQuery(ctx, 'chat', ['7', '--oversize'], { stale: false, mode: 'daemon' });
const rawRow = (rawPage.data as ChatData).messages[0];
hermeticChecks.oversizeOverrideVerbatim =
  rawRow.message === OVERSIZE_BODY && rawRow.withheld === undefined;

// --no-authored: names withheld with receipt, bodies stay
const nameFree = await serveQuery(ctx, 'chat', ['7'], { noAuthored: true, stale: false, mode: 'daemon' });
const nameFreeData = nameFree.data as ChatData;
hermeticChecks.nameFreeKeepsBodies = nameFreeData.messages[1].message === NORMAL_BODY;
hermeticChecks.nameFreeWithholdsNames =
  nameFreeData.messages.every((m) => m.account.name === undefined) &&
  (nameFree.meta as { suppressed?: string[] }).suppressed?.includes('messages[].account.name') === true;

// 3. kill-switch (hermetic)
let killSwitchCode = '';
try {
  await serveQuery({ ...ctx, chat: { enabled: false, maxBytes: MAX_BYTES } }, 'chat', ['7'], {
    stale: false,
    mode: 'daemon',
  });
} catch (e) {
  killSwitchCode = e instanceof QueryError ? e.code : 'WRONG_ERROR';
}
hermeticChecks.killSwitch = killSwitchCode === 'CHAT_DISABLED';

// 4. never-in-reports sweep (fixture-seeded)
const sweepArgs: Record<string, string[][]> = {
  kami: [['10016']],
  account: [[]],
  node: [['62']],
  party: [[]],
  item: [['1']],
  items: [[]],
  config: [['KAMI_STANDARD_COOLDOWN']],
  battles: [['10016']],
  trades: [[]],
  auctions: [[]],
  quests: [[]],
  market: [[]],
  portal: [[]],
  transfers: [[]],
  feed: [[]],
};
// account/party/portal/transfers need a real account index — find one
const accountIndex = await (async () => {
  for (const e of queryKamis(components).slice(0, 200)) {
    const idx = getKamiIndex(components, e);
    if (!idx) continue;
    const resp = await serveQuery(mirror, 'kami', [String(idx)], { stale: false, mode: 'daemon' });
    const acc = (resp.data as { account?: { index: number } }).account;
    if (acc?.index) return acc.index;
  }
  return 0;
})();
sweepArgs.account = [[String(accountIndex)]];
sweepArgs.party = [[String(accountIndex)]];
sweepArgs.portal = [[String(accountIndex)]];
sweepArgs.transfers = [[String(accountIndex)]];
sweepArgs.trades = [[], [String(accountIndex)]];
sweepArgs.quests = [[], [String(accountIndex)]];
// 0.2.0 surface — swept with real args so none is silently BAD_ARGS-skipped
const sweepRoom = (
  (await serveQuery(mirror, 'account', [String(accountIndex)], { stale: false, mode: 'daemon' }))
    .data as { roomIndex: number }
).roomIndex;
sweepArgs.inventory = [[String(accountIndex)]];
sweepArgs.room = [[String(sweepRoom)]];
sweepArgs.merchant = [[], ['1']];
sweepArgs.phase = [[]];
sweepArgs.leaderboard = [[]];
sweepArgs.killers = [[]];
sweepArgs.node = [['62'], ['62', '--with-vitals']];

let sweepQueries = 0;
const sweepLeaks: Record<string, unknown>[] = [];
for (const name of QUERY_NAMES) {
  if (name === 'chat') continue;
  for (const args of sweepArgs[name] ?? [[]]) {
    let out: unknown;
    try {
      out = await serveQuery(ctx, name, args, { prose: true, stale: false, mode: 'daemon' });
    } catch (e) {
      if (e instanceof QueryError && (e.code === 'NOT_FOUND' || e.code === 'BAD_ARGS')) continue;
      throw e;
    }
    sweepQueries++;
    const text = JSON.stringify(out);
    if (text.includes(SENTINEL) || text.includes(NORMAL_BODY)) {
      sweepLeaks.push({ query: name, args });
    }
  }
}
hermeticChecks.neverInReports = sweepLeaks.length === 0 && sweepQueries >= 22;

if (!Object.values(hermeticChecks).every(Boolean)) {
  fail('G4.c', { reason: 'hermetic chat-plan checks failed', hermeticChecks, sweepLeaks });
}
console.log(`hermetic chat-plan checks OK ${JSON.stringify(hermeticChecks)}`);

// ---- live: paginated passthrough + live sweep -------------------------------

const CANDIDATE_ROOMS = Array.from({ length: 80 }, (_, i) => i + 1);
const daemon = await spawnDaemonLive();
const liveChecks: Record<string, unknown> = {};
let liveRoom = 0;
let liveBodies: string[] = [];
let page1Count = 0;
let page2Count = 0;
let oldestTs = 0;

try {
  type LiveChat = { messages: { message?: string; timestamp: number; account: { index?: number } }[]; count: number };
  let page1: LiveChat | null = null;
  let page1Untrusted: string[] = [];
  const roomErrors: Record<string, unknown>[] = [];
  for (const room of CANDIDATE_ROOMS) {
    const resp = await socketQuery('chat', [String(room)]);
    if (!resp.ok) {
      roomErrors.push({ room, error: resp.error });
      continue; // an unknown room may error service-side; recorded
    }
    const data = resp.data as LiveChat;
    if (data.count > 0) {
      liveRoom = room;
      page1 = data;
      page1Untrusted = resp.untrusted ?? [];
      break;
    }
  }
  if (!page1) {
    fail('G4.c', { reason: 'no room with chat messages found in candidates', roomErrors: roomErrors.slice(0, 10) });
  }

  if (!ajv.validate('chat', page1)) {
    fail('G4.c', { reason: 'live chat page schema-invalid', errors: ajv.errors });
  }
  page1Count = page1.count;
  liveBodies = page1.messages.map((m) => m.message ?? '').filter((b) => b.length >= 8);
  liveChecks.bodiesTagged = page1Untrusted.includes('messages[].message');
  liveChecks.someBodies = page1.messages.some((m) => m.message !== undefined);

  // pagination: strictly older, no overlap
  oldestTs = Math.min(...page1.messages.map((m) => m.timestamp));
  const resp2 = await socketQuery('chat', [String(liveRoom), String(oldestTs)]);
  if (!resp2.ok) fail('G4.c', { reason: 'live chat page-2 failed', error: resp2.error });
  const page2 = resp2.data as LiveChat;
  page2Count = page2.count;
  liveChecks.page2StrictlyOlder = page2.messages.every((m) => m.timestamp < oldestTs);
  const key = (m: { timestamp: number; message?: string }) => `${m.timestamp}:${m.message ?? ''}`;
  const p1keys = new Set(page1.messages.map(key));
  liveChecks.noOverlap = page2.messages.every((m) => !p1keys.has(key(m)));

  // live never-in-reports: fetched bodies appear in no other live output
  const liveOutputs: string[] = [];
  for (const [q, args] of [
    ['status', []],
    ['feed', []],
    ['market', []],
    ['items', []],
    ['node', ['62']],
  ] as [string, string[]][]) {
    const r = await socketQuery(q, args);
    if (r.ok) liveOutputs.push(JSON.stringify(r.data));
  }
  const liveLeaks = liveBodies.filter((b) => liveOutputs.some((o) => o.includes(b)));
  liveChecks.liveNeverInReports = liveLeaks.length === 0;

  if (!liveChecks.bodiesTagged || !liveChecks.someBodies || !liveChecks.page2StrictlyOlder || !liveChecks.noOverlap || !liveChecks.liveNeverInReports) {
    fail('G4.c', { reason: 'live chat checks failed', liveChecks, liveLeaks });
  }
} finally {
  await daemon.stop();
}

// ---- live kill-switch cycle -------------------------------------------------

const daemon2 = await spawnDaemonLive({ KAMI_LENS_CHAT_ENABLED: 'false' });
let liveKillSwitch = false;
let chainStillServes = false;
try {
  const chatResp = await socketQuery('chat', ['1']);
  liveKillSwitch = !chatResp.ok && chatResp.error?.code === 'CHAT_DISABLED';
  const kamiResp = await socketQuery('items');
  chainStillServes = kamiResp.ok === true;
} finally {
  await daemon2.stop();
}
if (!liveKillSwitch || !chainStillServes) {
  fail('G4.c', { reason: 'live kill-switch cycle failed', liveKillSwitch, chainStillServes });
}

await writeMeasurement('g4c-chat', {
  hermeticChecks,
  hermetic: {
    oversizeBytes: expectedBytes,
    maxBytes: MAX_BYTES,
    sweepQueries,
    sweepLeaks,
  },
  live: {
    room: liveRoom,
    page1Count,
    page2Count,
    oldestTsPage1: oldestTs ? new Date(oldestTs).toISOString() : null,
    bodiesChecked: liveBodies.length,
    ...liveChecks,
  },
  killSwitch: { hermetic: hermeticChecks.killSwitch, live: liveKillSwitch, chainStillServes },
  match: true,
});

pass('G4.c', {
  hermetic: Object.keys(hermeticChecks).length,
  liveRoom,
  page1Count,
  page2Count,
  killSwitch: 'hermetic+live',
});
process.exit(0);
