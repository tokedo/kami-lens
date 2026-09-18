// kami-lens native module (not a port): the daemon's local query socket
// (DESIGN §3.6/§4.3). JSON-lines over a unix domain socket at
// <dataDir>/kami-lens.sock: one request object per line in, one response
// per line out.
//
//   request:  { id?, query, args?: string[], prose?, noAuthored? }
//   response: { id, ok: true, ...Envelope } |
//             { id, ok: false, error: { code, message } }
//
// `status` is served by the daemon itself (schema-checked like every
// query); everything else goes through the shared registry. Answers are
// stamped stale whenever the daemon is not LIVE or any tripwire has fired
// (G3.e: degraded honesty — serve last-synced state, say so).

import { createServer, Server, Socket } from 'node:net';
import { mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import * as clock from 'clock';
import { log } from 'utils/logger';
import { KamiLensDaemon } from './daemon';
import { SILENT_STALL_MS } from './kamiden';
import { buildEnvelope, QueryError, serveQuery } from './queries';
import { assertSocketArgs, loadSchema, REGISTRY, QueryName } from './queries/registry';
import { getVersionInfo } from './version';

export const SOCKET_NAME = 'kami-lens.sock';

export function socketPath(dataDir: string): string {
  return path.join(dataDir, SOCKET_NAME);
}

/** How long a status answer will wait for the chain head before giving up on
 * it. Deliberately short: the three head fields are worth having, and they
 * are not worth making `status` slow. */
const HEAD_SAMPLE_TIMEOUT_MS = 2_000;

/** A chain-head observation, sampled beside a status answer.
 *
 * PASSED IN RATHER THAN READ HERE, and that is the load-bearing part. This
 * function is synchronous and three gates call it on an UNSTARTED daemon
 * (G3.a, G3.g, G5.c) whose config points at a nonexistent data dir. If status
 * did its own RPC read, those captures would become network-dependent: on a
 * machine with connectivity the read succeeds, three keys appear, and G3.g
 * fails its own baseline for a reason that has nothing to do with the code
 * under test. With the sample as an argument the gates pass nothing, the
 * fields are omitted, the key set is unchanged, and no baseline needs
 * re-capturing. */
export type HeadSample = {
  /** chain head from one `eth_blockNumber` */
  blockNumber: number;
  /** when that read landed (§3.8 clock), so the pair is auditable rather
   * than a number of unknown age */
  sampledAt: string;
};

/** Sample the chain head for a status answer. Returns undefined on any
 * failure — the caller then omits all three head fields rather than serving
 * a 0 or a null (§3.14: the could-lie doctrine). The read goes through the
 * daemon's own reader, so its success and its last error are already counted
 * in `rpcReads`. */
export async function sampleHead(daemon: KamiLensDaemon): Promise<HeadSample | undefined> {
  try {
    // BOUNDED, because `status` is the one query that must always answer.
    // It is the daemon's own health surface: the local watchdog polls it
    // every 60 s and the container healthcheck every 30 s, and both read a
    // hang as "unreachable". An RPC that stops responding must cost this
    // answer three optional fields, never the answer itself — the same
    // never-block-the-mirror-on-an-RPC rule the gas block already follows.
    const blockNumber = await Promise.race([
      daemon.rpc.blockNumber(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), HEAD_SAMPLE_TIMEOUT_MS)),
    ]);
    if (blockNumber === undefined || !Number.isFinite(blockNumber)) return undefined;
    return { blockNumber, sampledAt: new Date(clock.now()).toISOString() };
  } catch {
    return undefined;
  }
}

/** §1.2 (0.5.2): Kamiden feed health, as an array shaped like `degraded` so
 * a caller gates on it the same way. It is SEPARATE from `degraded` and that
 * separation is the doctrine, not an oversight: `degraded` is CHAIN health
 * and drives `meta.stale`, and a Kamiden outage must never stamp a chain
 * answer stale (§3.2 soft dependency). But nine reads ARE Kamiden-backed,
 * and a session protocol that opens on `status` and gates every later read
 * on `degraded` alone was reading a healthy-looking daemon while the feed
 * flapped (observed 2026-08-27: stream `retrying`, 16 reconnects in 13 min,
 * `degraded: []`). Empty array when the feed is healthy — never absent, so
 * "the feed is fine" and "nobody looked" are different answers. */
export function feedsDegradedOf(kamiden: {
  stream: { state: string; silentMs: number };
}): string[] {
  const out: string[] = [];
  if (kamiden.stream.state !== 'live') out.push(`kamiden-stream:${kamiden.stream.state}`);
  if (kamiden.stream.silentMs > SILENT_STALL_MS) {
    out.push(`kamiden-silent:${Math.floor(kamiden.stream.silentMs / 1000)}s`);
  }
  return out;
}

export function buildStatusData(
  daemon: KamiLensDaemon,
  head?: HeadSample
): Record<string, unknown> {
  const s = daemon.getStatus();
  const versionInfo = getVersionInfo();
  // §3.15 (0.5.1): how far behind chain head the mirror is. `liveBlockNumber`
  // is a LOWER BOUND that does not advance on an event-less block, and
  // `meta.stale` is a boolean — so before this, no consumer could tell a
  // mirror three blocks behind from one three hours behind. All three fields
  // are ABSENT TOGETHER when the head read failed: never 0, never null.
  const headBlock = head
    ? {
        blockLag: Math.max(0, head.blockNumber - s.liveBlockNumber),
        headBlockNumber: head.blockNumber,
        headSampledAt: head.sampledAt,
      }
    : {};
  return {
    version: versionInfo.version,
    upstreamPin: versionInfo.upstreamPin,
    state: s.state,
    msg: s.msg,
    percentage: s.percentage,
    liveBlockNumber: s.liveBlockNumber,
    ...headBlock,
    streamSilentMs: s.streamSilentMs,
    bootstrapMode: s.bootstrapMode,
    resumeFromBlock: s.resumeFromBlock,
    startedAt: s.startedAt,
    liveAt: s.liveAt,
    // §3.5 (0.6.3): the report plus `inFlight`. Since divergence 16 the
    // write happens in a child process, so "a checkpoint is being written"
    // is a state this answer can actually be given DURING — before it, a
    // `status` asked mid-checkpoint did not come back at all (20-32 s of
    // silence every ten minutes on the VM), which is what the watchdog read
    // as a dead unit.
    checkpoint: s.checkpoint as unknown as Record<string, unknown> | null,
    tripwires: s.tripwires as unknown as Record<string, number>,
    degraded: s.degraded,
    // §1.2 (0.5.2): the Kamiden counterpart of `degraded`. See
    // feedsDegradedOf above for why the two arrays stay separate.
    feedsDegraded: feedsDegradedOf(s.kamiden),
    // per-feed Kamiden health (§3.2): surfaced separately from `degraded`,
    // which stays chain-only — a Kamiden outage must never stamp chain
    // answers stale
    kamiden: s.kamiden as unknown as Record<string, unknown>,
    // §3.13: the query layer's own chain reads (the account gas balance) —
    // the answer omits the block when a read fails, so its health is
    // reported here rather than nowhere
    rpcReads: s.rpcReads as unknown as Record<string, unknown>,
    // §3.17 (0.6.0): the sync layer's own recovery health. The 2026-09-06
    // phantom-harvest loss was undiagnosable because none of this existed:
    // gap-fills announced themselves at DEBUG, a cursor that advanced over
    // unapplied blocks announced itself not at all, and nothing said the
    // mirror was known-incomplete. `reconciledThrough` is the complete-range
    // lower bound that `liveBlockNumber` is not (§3.15).
    sync: s.sync as unknown as Record<string, unknown>,
    // §3.1 (0.6.2): which source served this process's full state load. The
    // answer to "did this daemon cold-boot from the CDN or from gRPC, and how
    // long did it take" without grepping a log the reader may not have. null
    // on a warm boot — no full load ran.
    lastFullLoad: s.lastFullLoad as unknown as Record<string, unknown> | null,
    clockOffsetMs: clock.offset(),
    clockLastSyncWallMs: clock.lastObservedAtWallMs(),
    config: {
      chainId: s.config.chainId,
      worldAddress: s.config.worldAddress,
      jsonRpcUrl: s.config.jsonRpcUrl,
      ...(s.config.wsRpcUrl ? { wsRpcUrl: s.config.wsRpcUrl } : {}),
      ...(s.config.kamigazeUrl ? { kamigazeUrl: s.config.kamigazeUrl } : {}),
      // §3.1 (0.6.2): absent when the state CDN is switched off, like every
      // other optional URL here. `configSources.stateCdnUrl` is ALWAYS
      // present, so which precedence level decided it — including a level
      // that decided "off" — stays readable either way (G5.c).
      ...(s.config.stateCdnUrl ? { stateCdnUrl: s.config.stateCdnUrl } : {}),
      ...(s.config.kamidenUrl ? { kamidenUrl: s.config.kamidenUrl } : {}),
      chatEnabled: s.config.chatEnabled,
      // the §3.12 enrichment flag, always surfaced (a switch you can only
      // see when it is on is not provenance) — the ONE key by which a
      // flag-off 0.4.0 answer differs from 0.3.0 (G3.g)
      enrich: s.config.enrich,
      ...(daemon.config.defaultOperator !== undefined
        ? { defaultOperator: daemon.config.defaultOperator }
        : {}),
      dataDir: s.config.dataDir,
      checkpointIntervalMs: s.config.checkpointIntervalMs,
    },
    // per-key precedence provenance (DESIGN §5; gate G5.c asserts the
    // flag > env > file > default matrix against this block)
    configSources: daemon.configSources as unknown as Record<string, string>,
    configFile: daemon.configFile,
  };
}

function isStale(daemon: KamiLensDaemon): boolean {
  const s = daemon.getStatus();
  return s.state !== 'LIVE' || s.degraded.length > 0;
}

type Request = {
  id?: string | number;
  query?: string;
  args?: string[];
  prose?: boolean;
  noAuthored?: boolean;
  oversize?: boolean;
};

async function handle(daemon: KamiLensDaemon, req: Request): Promise<Record<string, unknown>> {
  const id = req.id ?? null;
  try {
    if (!req.query) throw new QueryError('BAD_ARGS', 'request needs a query name');
    // §3.13 (0.5.2): AN UNDECLARED OPTION IS AN ERROR ON THIS PATH TOO. The
    // CLI has refused undeclared `--flags` since 0.5.0; the socket — the path
    // the harness and the agents actually use — silently ignored them, so
    // `account 3379 --slim` answered `ok: true` WITH the whole roster and
    // `node … --eligible-only` answered `ok: true` UNFILTERED. A caller got a
    // plausible answer to a question it did not ask, from the same daemon
    // that refused the identical tokens on the CLI. One rule now, in the
    // registry, used by both.
    assertSocketArgs(req.query, req.args ?? []);
    const opts = { prose: req.prose, noAuthored: req.noAuthored, oversize: req.oversize };
    if (req.query === 'status') {
      // §3.15 (0.5.1): one eth_blockNumber per status answer, awaited here
      // because `handle` is async and `buildStatusData` must stay sync (see
      // the note on HeadSample). A failure is not an error: the three head
      // fields are simply absent, and rpcReads.lastError says why.
      const envelope = buildEnvelope(
        buildStatusData(daemon, await sampleHead(daemon)),
        loadSchema('status'),
        { blockNumber: daemon.getStatus().liveBlockNumber, stale: isStale(daemon), mode: 'daemon' },
        opts
      );
      return { id, ok: true, ...envelope };
    }
    // §3.14 (0.5.2): a world read against a daemon that is not LIVE gets
    // NOT_READY, never NOT_FOUND. Before this, every read during a pre-LIVE
    // wedge answered `NOT_FOUND: node 9 not in mirror` — a code a caller
    // cannot tell from "that node does not exist", and one that sends it
    // hunting a missing entity instead of waiting for a daemon that is still
    // coming up (observed live 2026-08-27, nodes 9/10/86).
    //
    // SAFE AGAINST THE DEGRADED-HONESTY CONTRACT (G3.e), and this is the
    // load-bearing part: nothing moves the sync state away from LIVE once it
    // is reached. Every SyncState.FAILED transition in the ported worker is
    // strictly pre-LIVE, and onFailed returns early once `liveAt` is set. So
    // a post-LIVE stream outage still serves last-synced state stamped
    // `stale: true`, exactly as §3.2 requires — this gate cannot fire there.
    const state = daemon.getStatus();
    if (state.state !== 'LIVE') {
      throw new QueryError(
        'NOT_READY',
        `daemon not LIVE (${state.state} ${state.percentage}%): mirror empty` +
          (state.msg ? ` — ${state.msg}` : '')
      );
    }
    const mirror = daemon.getMirror();
    if (!mirror) throw new QueryError('NOT_READY', 'daemon not LIVE: mirror not initialized yet');
    const ctx = {
      mirror,
      kamiden: daemon.kamiden,
      chat: { enabled: daemon.config.chatEnabled, maxBytes: daemon.config.chatMaxBytes },
      // §3.12: enrichment is a DAEMON-level decision — no request field
      // carries it, so no caller can ask for a different surface than the
      // one this daemon was started with
      enrich: daemon.config.enrich,
      // §3.13: the one chain read the query layer makes. Assembled here, the
      // same way the Kamiden supervisor is, so no builder ever holds a
      // provider of its own.
      rpc: daemon.rpc,
    };
    // defaultOperator prefill (DESIGN §5): a convenience default for the
    // operator-argument tools when the argument is omitted — the same
    // general query, never a special path
    let args = req.args ?? [];
    const def = REGISTRY[req.query as QueryName];
    // COUNT POSITIONALS, NOT TOKENS (0.5.1). This read `args.length === 0`,
    // so a flag on its own suppressed the prefill: `party --full` or
    // `roster --stats` against a daemon with a defaultOperator answered
    // BAD_ARGS ("account index must be a non-negative integer") instead of
    // the configured account's report. Latent since --full (0.5.0); --stats
    // is the flag that makes it the common case, since it is the one a
    // reader passes with no other argument.
    const positionals = args.filter((a) => !a.startsWith('--'));
    if (def?.operatorArg && positionals.length === 0 && daemon.config.defaultOperator !== undefined) {
      args = [String(daemon.config.defaultOperator), ...args.filter((a) => a.startsWith('--'))];
    }
    const envelope = await serveQuery(ctx, req.query, args, {
      ...opts,
      stale: isStale(daemon),
      mode: 'daemon',
    });
    return { id, ok: true, ...envelope };
  } catch (e) {
    const code = e instanceof QueryError ? e.code : ((e as { code?: string }).code ?? 'INTERNAL');
    return { id, ok: false, error: { code, message: e instanceof Error ? e.message : String(e) } };
  }
}

/** Start the query socket. Returns the server; close() to stop. */
export function startQuerySocket(daemon: KamiLensDaemon, dataDir: string): Server {
  // zero-config first boot: the data dir may not exist yet — the socket
  // must not silently fail to listen (G5.a caught exactly this)
  mkdirSync(dataDir, { recursive: true });
  const sock = socketPath(dataDir);
  try {
    unlinkSync(sock);
  } catch {
    /* no stale socket */
  }
  const server = createServer((conn: Socket) => {
    let buffer = '';
    // async handlers (M4 kamiden passthroughs) — chain per connection so
    // responses keep request order on the line protocol
    let pending: Promise<void> = Promise.resolve();
    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let req: Request;
        try {
          req = JSON.parse(line) as Request;
        } catch {
          pending = pending.then(() => {
            conn.write(JSON.stringify({ id: null, ok: false, error: { code: 'BAD_ARGS', message: 'invalid JSON' } }) + '\n');
          });
          continue;
        }
        pending = pending
          .then(() => handle(daemon, req))
          .then((response) => {
            conn.write(JSON.stringify(response) + '\n');
          });
      }
    });
    conn.on('error', (e) => log.debug('[server] connection error', e));
  });
  server.on('error', (e) => log.error('[server] socket error', e));
  server.listen(sock, () => log.info(`[server] query socket at ${sock}`));
  return server;
}
