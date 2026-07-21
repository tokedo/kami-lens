#!/usr/bin/env node
// kami-lens native module (not a port): the CLI (DESIGN §3.6/§4.3).
//
//   kami-lens daemon                      run the sync daemon + query socket
//   kami-lens <query> [args...]           ask the running daemon → JSON
//   kami-lens kami <index> --stateless    single-kami vitals, no daemon
//
// Flags: --prose (opt-in authored-prose fields, e.g. account bio),
//        --no-authored (name-free mode: withhold authored-id with receipt),
//        --stateless (kami only), --data-dir <path>,
//        --oversize (chat only: serve oversize bodies verbatim instead of
//        withheld-with-receipt — DESIGN §3.10 raw-fetch override).
//
// Exit codes (documented):
//   0 success · 1 query error / daemon fatal · 2 usage ·
//   3 ERR_NO_SNAPSHOT_SOURCE from daemon mode (gate G1.e's loud-fail
//   marker — unchanged from M1) · 4 daemon unreachable ·
//   5 REQUIRES_DAEMON (stateless mode cannot serve this query — gate G3.d).

import { connect } from 'node:net';

import { buildEnvelope } from './queries';
import { loadSchema, QUERY_NAMES } from './queries/registry';
import { resolveConfig } from './config';
import { ERR_NO_SNAPSHOT_SOURCE, KamiLensDaemon } from './daemon';
import { socketPath, startQuerySocket } from './server';
import { statelessKami } from './stateless';

const EXIT_QUERY_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_NO_DAEMON = 4;
const EXIT_REQUIRES_DAEMON = 5;

function usage(): never {
  console.error(
    [
      'usage: kami-lens daemon',
      '       kami-lens <query> [args...] [--prose] [--no-authored] [--data-dir <path>]',
      '       kami-lens kami <index> --stateless',
      `queries: status, ${QUERY_NAMES.join(', ')}`,
    ].join('\n')
  );
  process.exit(EXIT_USAGE);
}

async function runDaemon(): Promise<void> {
  const daemon = new KamiLensDaemon();

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
  flags: Set<string>
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
  const config = resolveConfig();
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
  const [command, ...rest] = argv;

  if (command === 'daemon') return runDaemon();

  // --array (config) and --oversize (chat) are query arguments, not client
  // flags — they ride through as positionals for the query's parseArgs
  const flagList = rest.filter((a) => a.startsWith('--') && a !== '--array' && a !== '--oversize');
  const flags = new Set(flagList);
  let positional = rest.filter((a) => !flags.has(a));
  let dataDir = resolveConfig().dataDir;
  const dd = rest.indexOf('--data-dir');
  if (dd >= 0 && rest[dd + 1]) {
    dataDir = rest[dd + 1];
    positional = positional.filter((a) => a !== rest[dd + 1]);
  }

  if (flags.has('--stateless')) return runStateless(command, positional, flags);
  return runClient(command, positional, flags, dataDir);
}

void main();
