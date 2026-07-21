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
import { unlinkSync } from 'node:fs';
import path from 'node:path';

import * as clock from 'clock';
import { log } from 'utils/logger';
import { KamiLensDaemon } from './daemon';
import { buildEnvelope, QueryError, serveQuery } from './queries';
import { loadSchema } from './queries/registry';

export const SOCKET_NAME = 'kami-lens.sock';

export function socketPath(dataDir: string): string {
  return path.join(dataDir, SOCKET_NAME);
}

export function buildStatusData(daemon: KamiLensDaemon): Record<string, unknown> {
  const s = daemon.getStatus();
  return {
    state: s.state,
    msg: s.msg,
    percentage: s.percentage,
    liveBlockNumber: s.liveBlockNumber,
    streamSilentMs: s.streamSilentMs,
    startedAt: s.startedAt,
    liveAt: s.liveAt,
    checkpoint: s.checkpoint as unknown as Record<string, unknown> | null,
    tripwires: s.tripwires as unknown as Record<string, number>,
    degraded: s.degraded,
    clockOffsetMs: clock.offset(),
    clockLastSyncWallMs: clock.lastObservedAtWallMs(),
    config: {
      chainId: s.config.chainId,
      worldAddress: s.config.worldAddress,
      jsonRpcUrl: s.config.jsonRpcUrl,
      ...(s.config.wsRpcUrl ? { wsRpcUrl: s.config.wsRpcUrl } : {}),
      ...(s.config.kamigazeUrl ? { kamigazeUrl: s.config.kamigazeUrl } : {}),
      dataDir: s.config.dataDir,
      checkpointIntervalMs: s.config.checkpointIntervalMs,
    },
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
};

function handle(daemon: KamiLensDaemon, req: Request): Record<string, unknown> {
  const id = req.id ?? null;
  try {
    if (!req.query) throw new QueryError('BAD_ARGS', 'request needs a query name');
    const opts = { prose: req.prose, noAuthored: req.noAuthored };
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
    const envelope = serveQuery(mirror, req.query, req.args ?? [], {
      ...opts,
      stale: isStale(daemon),
      mode: 'daemon',
    });
    return { id, ok: true, ...envelope };
  } catch (e) {
    const code = e instanceof QueryError ? e.code : 'INTERNAL';
    return { id, ok: false, error: { code, message: e instanceof Error ? e.message : String(e) } };
  }
}

/** Start the query socket. Returns the server; close() to stop. */
export function startQuerySocket(daemon: KamiLensDaemon, dataDir: string): Server {
  const sock = socketPath(dataDir);
  try {
    unlinkSync(sock);
  } catch {
    /* no stale socket */
  }
  const server = createServer((conn: Socket) => {
    let buffer = '';
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
          conn.write(JSON.stringify({ id: null, ok: false, error: { code: 'BAD_ARGS', message: 'invalid JSON' } }) + '\n');
          continue;
        }
        conn.write(JSON.stringify(handle(daemon, req)) + '\n');
      }
    });
    conn.on('error', (e) => log.debug('[server] connection error', e));
  });
  server.on('error', (e) => log.error('[server] socket error', e));
  server.listen(sock, () => log.info(`[server] query socket at ${sock}`));
  return server;
}
