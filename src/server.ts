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
import { buildEnvelope, QueryError, serveQuery } from './queries';
import { loadSchema, REGISTRY, QueryName } from './queries/registry';
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
    checkpoint: s.checkpoint as unknown as Record<string, unknown> | null,
    tripwires: s.tripwires as unknown as Record<string, number>,
    degraded: s.degraded,
    // per-feed Kamiden health (§3.2): surfaced separately from `degraded`,
    // which stays chain-only — a Kamiden outage must never stamp chain
    // answers stale
    kamiden: s.kamiden as unknown as Record<string, unknown>,
    // §3.13: the query layer's own chain reads (the account gas balance) —
    // the answer omits the block when a read fails, so its health is
    // reported here rather than nowhere
    rpcReads: s.rpcReads as unknown as Record<string, unknown>,
    clockOffsetMs: clock.offset(),
    clockLastSyncWallMs: clock.lastObservedAtWallMs(),
    config: {
      chainId: s.config.chainId,
      worldAddress: s.config.worldAddress,
      jsonRpcUrl: s.config.jsonRpcUrl,
      ...(s.config.wsRpcUrl ? { wsRpcUrl: s.config.wsRpcUrl } : {}),
      ...(s.config.kamigazeUrl ? { kamigazeUrl: s.config.kamigazeUrl } : {}),
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
    const mirror = daemon.getMirror();
    if (!mirror) throw new QueryError('NOT_FOUND', 'mirror not initialized yet');
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
