#!/usr/bin/env node
// kami-lens native module (not a port): the CLI (DESIGN §3.6/§4.3/§5).
//
//   kami-lens daemon [config flags]       run the sync daemon + query socket
//   kami-lens <query> [args...]           ask the running daemon → JSON
//   kami-lens kami <index> --stateless    single-kami vitals, no daemon
//   kami-lens health [config flags]       exit 0 iff the daemon is LIVE
//                                         (container healthcheck backend)
//   kami-lens --version                   version + upstream pin
//
// Config flags (every mode; precedence flag > env > file > default, §5):
//   --config <path> --chain-id --world-address --initial-block --rpc-url
//   --rpc-ws-url --kamigaze-url --kamiden-url --kamiden-buffer-capacity
//   --chat-enabled true|false --chat-max-bytes --default-operator
//   --enrich true|false --data-dir <path> --checkpoint-interval-ms
// The enrichment flag (§3.12) is a DAEMON setting: `kami-lens daemon
// --enrich true` decides the surface every client of that daemon sees. Given
// to a query invocation it parses and does nothing — the query path is a
// socket client, and no request field carries enrichment.
// Client flags (every query): --prose (opt-in authored-prose fields, e.g.
//   account bio), --no-authored (name-free mode: withhold authored-id with
//   receipt), --stateless (kami only).
// Query ARGUMENTS are declared per query in the registry (REGISTRY[q].args)
//   and are parsed by the query itself: --full (compact listings serve their
//   whole shape and lift their row cap), --with-vitals (node), --open /
//   --accepted (quests), --array (config), --oversize (chat). An option a
//   query does not declare is a usage error, never a silent no-op (§3.13).
//
// Exit codes (documented):
//   0 success · 1 query error / daemon fatal · 2 usage ·
//   3 ERR_NO_SNAPSHOT_SOURCE from daemon mode (gate G1.e's loud-fail
//   marker — unchanged from M1) · 4 daemon unreachable ·
//   5 REQUIRES_DAEMON (stateless mode cannot serve this query — gate G3.d).

import { connect } from 'node:net';

import { buildEnvelope } from './queries';
import { loadSchema, QUERY_NAMES, REGISTRY } from './queries/registry';
import type { QueryName } from './queries/registry';
import { KamiLensConfig, parseConfigFlags, resolveConfigDetailed } from './config';
import { ERR_NO_SNAPSHOT_SOURCE, KamiLensDaemon } from './daemon';
import { socketPath, startQuerySocket } from './server';
import { statelessKami } from './stateless';
import { getVersionInfo } from './version';

/** Flags the CLI itself consumes, valid on every query. Everything else
 * `--`-prefixed must be declared by the query (REGISTRY[q].args) or it is a
 * usage error — see the routing note in main(). */
const CLIENT_FLAGS = new Set(['--prose', '--no-authored', '--stateless']);

const EXIT_QUERY_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_NO_DAEMON = 4;
const EXIT_REQUIRES_DAEMON = 5;

function usage(): never {
  console.error(
    [
      'usage: kami-lens daemon [config flags]',
      '       kami-lens <query> [args...] [--prose] [--no-authored] [config flags]',
      '       kami-lens kami <index> --stateless',
      '       kami-lens health [config flags]',
      '       kami-lens --version',
      `queries: status, ${QUERY_NAMES.join(', ')}`,
      "config flags: --config <path>, --chain-id, --world-address, --initial-block,",
      '  --rpc-url, --rpc-ws-url, --kamigaze-url, --kamiden-url,',
      '  --kamiden-buffer-capacity, --chat-enabled, --chat-max-bytes,',
      '  --enrich true|false (DAEMON-side payload enrichment, §3.12),',
      '  --default-operator, --data-dir, --checkpoint-interval-ms',
    ].join('\n')
  );
  process.exit(EXIT_USAGE);
}

async function runDaemon(configFlags: Partial<KamiLensConfig> & { configFile?: string }): Promise<void> {
  const daemon = new KamiLensDaemon({}, configFlags);

  daemon.status$.subscribe((status) => {
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        state: status.state,
        msg: status.msg,
        percentage: status.percentage,
        liveBlockNumber: status.liveBlockNumber,
        checkpoint: status.checkpoint,
        degraded: status.degraded,
      })
    );
  });

  const server = startQuerySocket(daemon, daemon.config.dataDir);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`[kami-lens] ${signal} — checkpointing and shutting down`);
    server.close();
    await daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await daemon.start();
    await daemon.live;
    console.error('[kami-lens] LIVE');
  } catch (e) {
    const error = e as Error & { code?: string };
    console.error(`[kami-lens] fatal: ${error.message}`);
    process.exit(error.code === ERR_NO_SNAPSHOT_SOURCE ? 3 : 1);
  }
}

async function runClient(
  query: string,
  positional: string[],
  flags: Set<string>,
  dataDir: string
): Promise<void> {
  const request = {
    id: 1,
    query,
    args: positional,
    prose: flags.has('--prose'),
    noAuthored: flags.has('--no-authored'),
  };
  const sock = socketPath(dataDir);
  await new Promise<void>((resolve) => {
    const conn = connect(sock);
    let buffer = '';
    conn.on('connect', () => conn.write(JSON.stringify(request) + '\n'));
    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const response = JSON.parse(buffer.slice(0, nl)) as { ok: boolean };
      console.log(JSON.stringify(response, null, 2));
      conn.end();
      process.exitCode = response.ok ? 0 : EXIT_QUERY_ERROR;
      resolve();
    });
    conn.on('error', () => {
      console.error(
        JSON.stringify({
          ok: false,
          error: {
            code: 'NO_DAEMON',
            message: `no daemon at ${sock} — start one with 'kami-lens daemon'`,
          },
        })
      );
      process.exitCode = EXIT_NO_DAEMON;
      resolve();
    });
  });
}

async function runStateless(
  query: string,
  positional: string[],
  flags: Set<string>,
  config: KamiLensConfig
): Promise<void> {
  if (query !== 'kami') {
    console.error(
      JSON.stringify({
        ok: false,
        error: {
          code: 'REQUIRES_DAEMON',
          message: `'${query}' is a discovery query — the answer only exists in the mirror; run the daemon`,
        },
      })
    );
    process.exit(EXIT_REQUIRES_DAEMON);
  }
  const index = Number(positional[0]);
  if (!Number.isInteger(index) || index < 0) usage();
  try {
    const data = await statelessKami(config, index);
    const envelope = buildEnvelope(
      data,
      loadSchema('kami-stateless' as never),
      { blockNumber: data.blockNumber, stale: false, mode: 'stateless' },
      { noAuthored: flags.has('--no-authored') }
    );
    console.log(JSON.stringify({ id: 1, ok: true, ...envelope }, null, 2));
  } catch (e) {
    console.error(
      JSON.stringify({
        ok: false,
        error: {
          code: 'STATELESS_FAILED',
          message: e instanceof Error ? e.message : String(e),
        },
      })
    );
    process.exit(EXIT_QUERY_ERROR);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage();

  if (argv[0] === '--version' || argv[0] === '-v') {
    const { version, upstreamPin } = getVersionInfo();
    console.log(`kami-lens ${version} (upstream Asphodel-OS/kamigotchi @ ${upstreamPin})`);
    return;
  }

  const [command, ...rest] = argv;

  // config flags are valid in every mode; parse them out first
  let configFlags: Partial<KamiLensConfig> & { configFile?: string };
  let remaining: string[];
  try {
    ({ flags: configFlags, rest: remaining } = parseConfigFlags(rest));
  } catch (e) {
    console.error(`[kami-lens] ${e instanceof Error ? e.message : e}`);
    process.exit(EXIT_USAGE);
  }

  if (command === 'daemon') {
    if (remaining.length > 0) usage();
    return runDaemon(configFlags);
  }

  if (command === 'health') {
    // healthcheck backend (G5.b): one status round-trip; LIVE → 0, else 1
    const dataDir = resolveConfigDetailed({}, configFlags).config.dataDir;
    const sock = socketPath(dataDir);
    const state = await new Promise<string>((resolve) => {
      const conn = connect(sock);
      let buffer = '';
      conn.on('connect', () => conn.write(JSON.stringify({ id: 1, query: 'status' }) + '\n'));
      conn.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const nl = buffer.indexOf('\n');
        if (nl < 0) return;
        conn.end();
        try {
          const resp = JSON.parse(buffer.slice(0, nl)) as { ok: boolean; data?: { state?: string } };
          resolve(resp.ok ? (resp.data?.state ?? 'UNKNOWN') : 'ERROR');
        } catch {
          resolve('ERROR');
        }
      });
      conn.on('error', () => resolve('NO_DAEMON'));
      setTimeout(() => resolve('TIMEOUT'), 10_000).unref?.();
    });
    console.log(state);
    process.exit(state === 'LIVE' ? 0 : 1);
  }

  // Query ARGUMENTS (--full, --with-vitals, --open, --array, --oversize, …)
  // ride through as positionals for the query's own parseArgs; CLIENT flags
  // are handled here. Which is which comes from the registry's declared arg
  // vocabulary, never from a list written down twice.
  //
  // WHY THIS IS NOT A FILTER (§3.13): it used to be. The old code kept a
  // hand-written allowlist of three query-argument spellings and routed
  // everything else `--`-prefixed into the client-flag set, where anything
  // it did not recognise was dropped without a word. `kami-lens quests 78
  // --full` would have answered the COMPACT form, and a typo would have done
  // the same — a different answer, silently, which is precisely the failure
  // DESIGN §3.1 exists to refuse. An undeclared flag is now a usage error.
  const queryArgs = new Set(REGISTRY[command as QueryName]?.args ?? []);
  const knownQuery = command === 'status' || command in REGISTRY;
  const flags = new Set<string>();
  const positional: string[] = [];
  for (const arg of remaining) {
    if (!arg.startsWith('--')) {
      positional.push(arg);
    } else if (queryArgs.has(arg)) {
      positional.push(arg);
    } else if (CLIENT_FLAGS.has(arg)) {
      flags.add(arg);
    } else if (!knownQuery) {
      // an unknown query name is the real error — let the daemon say so
      // rather than complaining about the flags of a query that does not exist
      flags.add(arg);
    } else {
      const accepted = [...queryArgs, ...CLIENT_FLAGS].sort();
      console.error(
        `[kami-lens] unknown option '${arg}' for '${command}' — accepts: ${accepted.join(', ')}`
      );
      process.exit(EXIT_USAGE);
    }
  }
  const resolved = resolveConfigDetailed({}, configFlags).config;

  if (flags.has('--stateless')) return runStateless(command, positional, flags, resolved);
  return runClient(command, positional, flags, resolved.dataDir);
}

void main();
