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
//   --reconcile-interval-ms (0 = off, §3.17)
//   --state-cdn-url <url>|none|false|'' (§3.1; DEFAULT ON — the empty
//     string, `none` or `false` takes the Kamigaze gRPC cold start instead)
// The enrichment flag (§3.12) is a DAEMON setting: `kami-lens daemon
// --enrich true` decides the surface every client of that daemon sees. Given
// to a query invocation it parses and does nothing — the query path is a
// socket client, and no request field carries enrichment.
// Client flags (every query): --prose (opt-in authored-prose fields, e.g.
//   account bio), --no-authored (name-free mode: withhold authored-id with
//   receipt), --stateless (kami only).
// Query ARGUMENTS are declared per query in the registry (REGISTRY[q].args)
//   and are parsed by the query itself: --full (compact listings serve their
//   whole shape and lift their row cap), --with-vitals (node), --stats (kami,
//   roster, party, node --with-vitals: the kami sheet's stat block +
//   affinities; on roster it also CAPS the list), --open /
//   --accepted (quests), --array (config), --oversize (chat). An option a
//   query does not declare is a usage error, never a silent no-op (§3.13).
//
// Exit codes (documented):
//   0 success · 1 query error / daemon fatal · 2 usage ·
//   3 ERR_NO_SNAPSHOT_SOURCE from daemon mode (gate G1.e's loud-fail
//   marker — unchanged from M1) · 4 daemon unreachable ·
//   5 REQUIRES_DAEMON (stateless mode cannot serve this query — gate G3.d).

import { connect } from 'node:net';

import { buildEnvelope, QueryError } from './queries';
import { loadSchema, QUERY_NAMES, routeCliArgs } from './queries/registry';
import { KamiLensConfig, parseConfigFlags, resolveConfigDetailed } from './config';
import { ERR_NO_SNAPSHOT_SOURCE, KamiLensDaemon } from './daemon';
import {
  COLD_BOOT_HEAP_FLOOR_MB,
  decideHeap,
  ERR_INSUFFICIENT_MEMORY,
  HEAP_REEXEC_ENV,
  readHeapInputs,
} from './heap';
import { socketPath, startQuerySocket } from './server';
import { statelessKami } from './stateless';
import { getVersionInfo } from './version';

const EXIT_QUERY_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_NO_DAEMON = 4;
const EXIT_REQUIRES_DAEMON = 5;
/** §3.1 (0.6.3): not enough heap to finish a cold load. Its own code, like
 * ERR_NO_SNAPSHOT_SOURCE's 3, so a supervisor can tell "this box cannot run
 * me" from "this query failed". */
const EXIT_INSUFFICIENT_MEMORY = 6;

/**
 * Heap self-sizing for the DAEMON, and only the daemon (§3.1, §5;
 * src/heap.ts has the measurement and the truth table).
 *
 * NEVER FOR A QUERY. A CLI query is a socket client that exits in a second
 * and needs a few MB; re-exec'ing one would double its startup for nothing,
 * and refusing one on a small box would break the stateless path that
 * exists precisely for small boxes.
 *
 * Placed at the top of the daemon branch, which is after this module's
 * imports (ESM hoists them) but before a single byte of network, cache or
 * CDN work. A re-exec therefore costs one module graph — measured ~0.3 s —
 * and never a partial load.
 */
function ensureDaemonHeap(): void {
  const inputs = readHeapInputs();
  const decision = decideHeap(inputs);

  if (decision.action === 'refuse') {
    console.error(`[kami-lens] ${ERR_INSUFFICIENT_MEMORY}: ${decision.reason}`);
    process.exit(EXIT_INSUFFICIENT_MEMORY);
  }

  if (decision.action === 'warn-proceed') {
    console.error(`[kami-lens] WARNING: ${decision.detail}`);
    return;
  }

  if (decision.action === 'proceed') {
    // the other half of the re-exec's story, logged by the process that
    // came back: an operator reading the log sees "was X, restarting with
    // Y" and then "now Y", rather than a restart with no confirmation
    if (inputs.marker) {
      console.error(
        `[kami-lens] heap limit is now ${inputs.limitMb} MB (self-configured, floor ` +
          `${COLD_BOOT_HEAP_FLOOR_MB} MB) — same pid, restarted image`
      );
    }
    return;
  }

  // REPLACE THIS PROCESS, same pid. A supervisor's child must not become a
  // grandchild: launchd and systemd both track what they started, so
  // spawning a second node and forwarding signals would turn one legible
  // process into two and a signal-relay bug waiting to happen. execve
  // swaps the image in place — same pid, same fds, same supervisor
  // relationship, new heap cap.
  //
  // The ExperimentalWarning execve prints is SUPPRESSED, deliberately and
  // narrowly: it is stderr noise on every single daemon start, the API is
  // load-bearing here, and the one line logged below says what happened in
  // terms an operator can act on. Nothing else is filtered.
  const { targetMb } = decision;
  const argv = [
    process.execPath,
    `--max-old-space-size=${targetMb}`,
    ...process.execArgv,
    ...process.argv.slice(1),
  ];
  console.error(
    `[kami-lens] heap limit ${inputs.limitMb} MB is below the ${COLD_BOOT_HEAP_FLOOR_MB} MB ` +
      `cold-boot floor; restarting in place with --max-old-space-size=${targetMb} ` +
      `(${inputs.effectiveMemMb} MB available to this process). A cold boot builds the whole ECS ` +
      `image in memory: measured peak RSS 4.2-4.4 GB.`
  );
  const execve = (process as unknown as {
    execve: (path: string, args: string[], env: NodeJS.ProcessEnv) => never;
  }).execve;
  try {
    execve(process.execPath, argv, {
      ...process.env,
      [HEAP_REEXEC_ENV]: '1',
      // keep the warning off the operator's stderr on every start; the
      // line above already said what is happening and why
      NODE_NO_WARNINGS: '1',
    });
  } catch (e) {
    // execve exists but refused (a platform that cannot, a sealed process).
    // Refuse rather than carry on into a load that cannot finish.
    console.error(
      `[kami-lens] ${ERR_INSUFFICIENT_MEMORY}: could not raise the heap limit in place ` +
        `(${e instanceof Error ? e.message : String(e)}). Start it with the cap instead:\n\n` +
        `    NODE_OPTIONS=--max-old-space-size=${targetMb} kami-lens daemon\n`
    );
    process.exit(EXIT_INSUFFICIENT_MEMORY);
  }
}

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
      '  --default-operator, --data-dir, --checkpoint-interval-ms,',
      '  --reconcile-interval-ms (0 = off, §3.17),',
      "  --state-cdn-url <url>|none|false|'' (state CDN cold boot, §3.1;",
      '    default ON — switching it off takes the gRPC cold start)',
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
    // BEFORE any network, cache or CDN work — and after this call the
    // process may be a different image with the same pid (§3.1).
    ensureDaemonHeap();
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
  //
  // 0.5.2: the loop that did this lives in the registry now, because the
  // SOCKET needed the identical rule and having it written down twice is how
  // the two paths came to disagree in the first place.
  let positional: string[];
  let flags: Set<string>;
  try {
    ({ positional, flags } = routeCliArgs(command, remaining));
  } catch (e) {
    console.error(`[kami-lens] ${e instanceof QueryError ? e.message : String(e)}`);
    process.exit(EXIT_USAGE);
  }
  const resolved = resolveConfigDetailed({}, configFlags).config;

  if (flags.has('--stateless')) return runStateless(command, positional, flags, resolved);
  return runClient(command, positional, flags, resolved.dataDir);
}

void main();
