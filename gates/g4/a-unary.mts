// Gate G4.a [live] — unary feed conformance. Each of the 12 served unary
// methods is called live through the query surface → decodes → validates
// against its checked-in schema → every entity id in the response resolves
// against the mirror at the same block (the passthrough-with-joins rows
// must carry a resolved index for every non-empty id; '' and '0' are the
// service's documented "none" values and are counted, not failed).
// Observed history depth is RECORDED as a measurement, never asserted —
// Kamiden retention is unverified, the same epistemic status as
// GetEventsSince (PORT_PLAN). The §3.10 envelope of every live answer is
// re-derived with the independent walker and compared exactly (the G3.f
// check, extended to the kamiden-backed queries that cannot run
// hermetically).
//
// Method → query coverage (12/12):
//   GetBattles + GetBattleStats            battles <kamiIndex>
//   GetTradeHistory + GetOpenOffers        trades <accountIndex>
//   GetKamiMarketListings/Bids/History     market [<accountIndex>]
//   GetTokenDeposits/Withdrawals/Open      portal <accountIndex>
//   GetItemTransfers                       transfers <accountIndex>
//   GetAuctionBuys                         auctions <itemIndex>

import { readFileSync } from 'node:fs';
import path from 'node:path';

import Ajv from 'ajv/dist/2020';

import { loadSchema } from '../../src/queries/registry';
import { fail, pass, REPO_ROOT, writeMeasurement } from '../g1/lib.mts';
import {
  deriveAuthoredPaths,
  presentPath,
  socketQuery,
  spawnDaemonLive,
  SocketResponse,
} from './lib.mts';

const classification = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'docs', 'string-classification.json'), 'utf8')
) as { default: string; types: Record<string, Record<string, string>> };

const ajv = new Ajv({ strict: true, allErrors: true });
for (const name of ['battles', 'trades', 'auctions', 'quests', 'market', 'portal', 'transfers'] as const) {
  ajv.addSchema(loadSchema(name), name);
}

type IdRef = { id: string; index?: number; name?: string };
const NONE_IDS = new Set(['', '0']);

const resolution = { checked: 0, resolved: 0, none: 0, failures: [] as Record<string, unknown>[] };
function checkRef(where: string, ref: IdRef | undefined): void {
  if (!ref) return;
  resolution.checked++;
  if (NONE_IDS.has(ref.id)) {
    resolution.none++;
    return;
  }
  if (ref.index !== undefined) {
    resolution.resolved++;
    return;
  }
  if (resolution.failures.length < 20) resolution.failures.push({ where, id: ref.id });
  else resolution.failures.push({ where, id: 'suppressed' });
}

const envelopeMismatches: Record<string, unknown>[] = [];
function checkAnswer(query: string, args: string[], resp: SocketResponse): unknown {
  if (!resp.ok) {
    fail('G4.a', { reason: `${query} ${args.join(' ')} failed`, error: resp.error });
  }
  if (!ajv.validate(query, resp.data)) {
    fail('G4.a', { reason: `${query} schema-invalid`, args, errors: ajv.errors });
  }
  const derived = deriveAuthoredPaths(loadSchema(query as never) as never, classification as never)
    .filter((p) => presentPath(resp.data, p))
    .sort();
  if (JSON.stringify(derived) !== JSON.stringify(resp.untrusted ?? [])) {
    envelopeMismatches.push({ query, args, derived, emitted: resp.untrusted });
  }
  return resp.data;
}

const daemon = await spawnDaemonLive();
try {
  const calls: Record<string, { rows: number; oldestTsMs: number | null }> = {};
  const record = (method: string, rows: number, oldestTsMs: number | null) => {
    const prev = calls[method];
    calls[method] = {
      rows: (prev?.rows ?? 0) + rows,
      oldestTsMs:
        oldestTsMs === null
          ? (prev?.oldestTsMs ?? null)
          : Math.min(prev?.oldestTsMs ?? Infinity, oldestTsMs),
    };
  };

  // --- auctions → GetAuctionBuys --------------------------------------------
  const auctionsResp = await socketQuery('auctions');
  const auctionsData = checkAnswer('auctions', [], auctionsResp) as {
    auctions: { auctionItem?: { index: number } }[];
  };
  const auctionItem = auctionsData.auctions.find((a) => a.auctionItem?.index)?.auctionItem?.index;
  if (!auctionItem) fail('G4.a', { reason: 'no auction with an item in the mirror' });
  const buysResp = await socketQuery('auctions', [String(auctionItem)]);
  const buysData = checkAnswer('auctions', [String(auctionItem)], buysResp) as {
    buys?: { timestamp: number }[];
  };
  const buys = buysData.buys ?? [];
  // AuctionBuy.Timestamp is SECONDS (measured — a ms reading dates to
  // 1970), unlike the ms Message/market timestamps; recorded raw
  const oldestAuctionBuyRaw = buys.length ? Math.min(...buys.map((b) => b.timestamp)) : null;
  record('GetAuctionBuys', buys.length, null);

  // --- market → listings/bids/history ---------------------------------------
  const marketResp = await socketQuery('market');
  const marketData = checkAnswer('market', [], marketResp) as {
    listings: { seller: IdRef; buyer?: IdRef; timestamp: number }[];
    bids: { buyer: IdRef; timestamp: number }[];
  };
  for (const l of marketData.listings) {
    checkRef('market.listings.seller', l.seller);
    checkRef('market.listings.buyer', l.buyer);
  }
  for (const b of marketData.bids) checkRef('market.bids.buyer', b.buyer);
  record(
    'GetKamiMarketListings',
    marketData.listings.length,
    marketData.listings.length ? Math.min(...marketData.listings.map((l) => l.timestamp)) : null
  );
  record(
    'GetKamiMarketBids',
    marketData.bids.length,
    marketData.bids.length ? Math.min(...marketData.bids.map((b) => b.timestamp)) : null
  );

  // candidate accounts: resolved market participants, most recent first
  const candidates = [
    ...marketData.listings.map((l) => l.seller.index),
    ...marketData.listings.map((l) => l.buyer?.index),
    ...marketData.bids.map((b) => b.buyer.index),
  ].filter((i): i is number => i !== undefined);
  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.length === 0) fail('G4.a', { reason: 'no resolvable market participants' });

  const historyResp = await socketQuery('market', [String(uniqueCandidates[0])]);
  const historyData = checkAnswer('market', [String(uniqueCandidates[0])], historyResp) as {
    orders?: { timestamp: number }[];
  };
  const orders = historyData.orders ?? [];
  record(
    'GetKamiMarketHistory',
    orders.length,
    orders.length ? Math.min(...orders.map((o) => o.timestamp)) : null
  );

  // --- per-account: trades / transfers / portal ------------------------------
  // walk candidates until each method has produced at least one non-empty
  // response (or the cap is hit — emptiness is recorded, not asserted)
  let tradesSeen = 0;
  let offersSeen = 0;
  let transfersSeen = 0;
  let receiptsSeen = 0;
  let openWithdrawalsSeen = 0;
  // Trade.CreateTimestamp and PortalReceipt.Timestamp are proto STRINGS of
  // unverified unit (s vs ms) — recorded raw, converted by no one
  let oldestTradeCreateRaw: number | null = null;
  let oldestReceiptRaw: number | null = null;
  const tried: number[] = [];
  for (const acc of uniqueCandidates.slice(0, 12)) {
    tried.push(acc);
    const tradesResp = await socketQuery('trades', [String(acc)]);
    const tradesData = checkAnswer('trades', [String(acc)], tradesResp) as {
      history?: { maker: IdRef; taker: IdRef; timestamps: { create: string } }[];
      openOffers?: { maker: IdRef; taker: IdRef }[];
    };
    const history = tradesData.history ?? [];
    const offers = tradesData.openOffers ?? [];
    for (const t of history) {
      checkRef('trades.history.maker', t.maker);
      checkRef('trades.history.taker', t.taker);
    }
    for (const t of offers) {
      checkRef('trades.openOffers.maker', t.maker);
      checkRef('trades.openOffers.taker', t.taker);
    }
    tradesSeen += history.length;
    offersSeen += offers.length;
    const createsRaw = history
      .map((t) => Number(t.timestamps.create))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (createsRaw.length) {
      const min = Math.min(...createsRaw);
      oldestTradeCreateRaw = oldestTradeCreateRaw === null ? min : Math.min(oldestTradeCreateRaw, min);
    }
    record('GetTradeHistory', history.length, null);
    record('GetOpenOffers', offers.length, null);

    const transfersResp = await socketQuery('transfers', [String(acc)]);
    const transfersData = checkAnswer('transfers', [String(acc)], transfersResp) as {
      transfers: { sender: IdRef; recipient: IdRef }[];
    };
    for (const t of transfersData.transfers) {
      checkRef('transfers.sender', t.sender);
      checkRef('transfers.recipient', t.recipient);
    }
    transfersSeen += transfersData.transfers.length;
    record('GetItemTransfers', transfersData.transfers.length, null);

    const portalResp = await socketQuery('portal', [String(acc)]);
    const portalData = checkAnswer('portal', [String(acc)], portalResp) as {
      receipts: { account: IdRef; timestamp: string }[];
      openWithdrawals: { account: IdRef }[];
    };
    for (const r of portalData.receipts) checkRef('portal.receipts.account', r.account);
    for (const r of portalData.openWithdrawals) checkRef('portal.open.account', r.account);
    receiptsSeen += portalData.receipts.length;
    openWithdrawalsSeen += portalData.openWithdrawals.length;
    const receiptsRaw = portalData.receipts
      .map((r) => Number(r.timestamp))
      .filter((t) => Number.isFinite(t) && t > 0);
    if (receiptsRaw.length) {
      const min = Math.min(...receiptsRaw);
      oldestReceiptRaw = oldestReceiptRaw === null ? min : Math.min(oldestReceiptRaw, min);
    }
    record('GetTokenWithdrawals+Deposits', portalData.receipts.length, null);
    record('GetOpenWithdrawals', portalData.openWithdrawals.length, null);

    if (tradesSeen > 0 && transfersSeen > 0 && (receiptsSeen > 0 || openWithdrawalsSeen > 0)) break;
  }

  // --- battles: a busy node's kamis -----------------------------------------
  let battleKills = 0;
  let battleStats = false;
  let battlesTried = 0;
  let oldestKillMs: number | null = null;
  outer: for (const nodeIndex of [62, 1, 5, 9, 13, 27, 41, 55]) {
    const nodeResp = await socketQuery('node', [String(nodeIndex)]);
    if (!nodeResp.ok) continue;
    const harvests = (nodeResp.data as { harvests: { kami: { index: number } }[] }).harvests;
    for (const h of harvests) {
      if (battlesTried >= 15) break outer;
      if (!h.kami.index) continue;
      battlesTried++;
      const battlesResp = await socketQuery('battles', [String(h.kami.index)]);
      const battlesData = checkAnswer('battles', [String(h.kami.index)], battlesResp) as {
        stats?: { kills: number; deaths: number };
        kills: { killer: IdRef; victim: IdRef; account: IdRef; timestamp: number }[];
      };
      if (battlesData.stats) battleStats = true;
      for (const k of battlesData.kills) {
        checkRef('battles.kills.killer', k.killer);
        checkRef('battles.kills.victim', k.victim);
        checkRef('battles.kills.account', k.account);
      }
      battleKills += battlesData.kills.length;
      if (battlesData.kills.length) {
        const oldest = Math.min(...battlesData.kills.map((k) => k.timestamp));
        oldestKillMs = oldestKillMs === null ? oldest : Math.min(oldestKillMs, oldest);
      }
      record(
        'GetBattles',
        battlesData.kills.length,
        battlesData.kills.length ? Math.min(...battlesData.kills.map((k) => k.timestamp)) : null
      );
      record('GetBattleStats', battlesData.stats ? 1 : 0, null);
      if (battleKills > 0 && battleStats) break outer;
    }
  }
  if (battleKills === 0) {
    fail('G4.a', { reason: 'no kami with battle history found on sampled nodes', battlesTried });
  }

  // --- verdict ---------------------------------------------------------------
  const statusResp = await socketQuery('status');
  const kamidenStatus = (statusResp.data as { kamiden: { unary: Record<string, { ok: number; errors: number }> } }).kamiden;
  const methodsCalled = Object.keys(kamidenStatus.unary).sort();

  const depths = Object.fromEntries(
    Object.entries(calls).map(([m, v]) => [
      m,
      {
        rows: v.rows,
        oldestTs: v.oldestTsMs && Number.isFinite(v.oldestTsMs) ? new Date(v.oldestTsMs).toISOString() : null,
        depthDays:
          v.oldestTsMs && Number.isFinite(v.oldestTsMs)
            ? Number(((Date.now() - v.oldestTsMs) / 86_400_000).toFixed(1))
            : null,
      },
    ])
  );

  await writeMeasurement('g4a-unary', {
    blockNumber: (statusResp.data as { liveBlockNumber: number }).liveBlockNumber,
    methodsCalled,
    perMethodHealth: kamidenStatus.unary,
    observedDepth_recordedNotAsserted: depths,
    resolution: { ...resolution, failures: resolution.failures.slice(0, 20) },
    envelopeMismatches,
    samples: {
      auctionItem,
      marketAccounts: uniqueCandidates.slice(0, 12).length,
      accountsTried: tried,
      battleKills,
      battleStats,
      tradesSeen,
      offersSeen,
      transfersSeen,
      receiptsSeen,
      openWithdrawalsSeen,
      oldestTradeCreateRaw_unitUnverified: oldestTradeCreateRaw,
      oldestReceiptRaw_unitUnverified: oldestReceiptRaw,
      oldestAuctionBuyRaw_secondsMeasured: oldestAuctionBuyRaw,
    },
    match: resolution.failures.length === 0 && envelopeMismatches.length === 0,
  });

  const EXPECTED = [
    'GetAuctionBuys',
    'GetBattleStats',
    'GetBattles',
    'GetItemTransfers',
    'GetKamiMarketBids',
    'GetKamiMarketHistory',
    'GetKamiMarketListings',
    'GetOpenOffers',
    'GetOpenWithdrawals',
    'GetTokenDeposits',
    'GetTokenWithdrawals',
    'GetTradeHistory',
  ];
  const missing = EXPECTED.filter((m) => !methodsCalled.includes(m));
  const unhealthy = EXPECTED.filter((m) => (kamidenStatus.unary[m]?.ok ?? 0) === 0);
  if (missing.length > 0 || unhealthy.length > 0) {
    fail('G4.a', { reason: 'not all 12 methods called successfully', missing, unhealthy });
  }
  if (resolution.failures.length > 0) {
    fail('G4.a', { reason: 'unresolvable entity ids', failures: resolution.failures.slice(0, 20) });
  }
  if (envelopeMismatches.length > 0) {
    fail('G4.a', { reason: 'envelope divergence on live answers', envelopeMismatches });
  }
  pass('G4.a', {
    methods: 12,
    refsChecked: resolution.checked,
    refsResolved: resolution.resolved,
    refsNone: resolution.none,
    battleKills,
  });
} finally {
  await daemon.stop();
}
process.exit(0);
