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

export function buildStatusData(daemon: KamiLensDaemon): Record<string, unknown> {
  const s = daemon.getStatus();
  const versionInfo = getVersionInfo();
  return {
    version: versionInfo.version,
    upstreamPin: versionInfo.upstreamPin,
    state: s.state,
    msg: s.msg,
    percentage: s.percentage,
    liveBlockNumber: s.liveBlockNumber,
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
      const envelope = buildEnvelope(
        buildStatusData(daemon),
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
    };
    // defaultOperator prefill (DESIGN §5): a convenience default for the
    // operator-argument tools when the argument is omitted — the same
    // general query, never a special path
    let args = req.args ?? [];
    const def = REGISTRY[req.query as QueryName];
    if (def?.operatorArg && args.length === 0 && daemon.config.defaultOperator !== undefined) {
      args = [String(daemon.config.defaultOperator)];
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
