// 1.1.1 (O-TS14, O-TS20): usage lines, CLIENT side — the query set and every
// served answer are unchanged.
//
// Through 1.1.0: `kami-lens --help` answered `unknown query '--help'` (and
// only with a daemon up), `kami-lens quests --help` printed the option list
// and nothing about positionals, and a BAD_ARGS printed its message with no
// usage at all — so a reader that wrote no plan re-derived the CLI's shape
// every session, and `node 1 --with-vitals --attacker-kami-index …` (the
// harness tool's parameter names) never learned that the attacker is a
// POSITIONAL. Now:
//   - `kami-lens help` / `--help` / `-h` print the catalog built from the
//     registry's own declarations; `<query> --help` that query's block;
//   - a router BAD_ARGS on the CLI prints the message, then `usage: …`;
//   - a BAD_ARGS on the socket carries ` — usage: …` in its message;
//   - `unknown query` keeps its `have:` list and adds `; try: kami-lens help`.
//
// Hermetic. The CLI runs with HOME and --data-dir in a fresh temp dir, so it
// can never find (or read the config of) a daemon on this machine; the socket
// cases use an unstarted daemon over a synthetic mirror.

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KamiLensDaemon } from '../src/daemon';
import { QueryError } from '../src/queries/build';
import * as registry from '../src/queries/registry';
import { QUERY_NAMES, REGISTRY } from '../src/queries/registry';
import { socketPath, startQuerySocket } from '../src/server';
import { resetSyncHealth } from '../src/sync-health';
import { addKami, makeMirror } from './support/mirror';

const REPO = path.resolve(import.meta.dirname, '..');

// the 1.1.1 registry helpers, read through the namespace so this file still
// LOADS against a registry that lacks them (and fails per test, not at import)
const reg = registry as unknown as {
  usageLine?: (q: string) => string | undefined;
  helpCatalog?: () => string[];
};

let dir = '';
let server: ReturnType<typeof startQuerySocket> | null = null;
beforeEach(async () => {
  resetSyncHealth();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kl-usage-'));
});
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  await fs.rm(dir, { recursive: true, force: true });
});

/** Run the CLI from source, isolated: HOME and the data dir are the test's
 * own temp dir, so no default path on this machine is ever touched. */
function cli(...args: string[]) {
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join(REPO, 'src', 'cli.ts'), ...args, '--data-dir', dir],
    {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, HOME: dir, NODE_NO_WARNINGS: '1' },
    }
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

type Reply = { ok: boolean; error?: { code?: string; message?: string } };

function ask(sock: string, req: Record<string, unknown>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const conn = connect(sock);
    let buf = '';
    conn.on('connect', () => conn.write(JSON.stringify({ id: 1, ...req }) + '\n'));
    conn.on('data', (c) => {
      buf += c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      conn.end();
      resolve(JSON.parse(buf.slice(0, nl)) as Reply);
    });
    conn.on('error', reject);
  });
}

/** A LIVE daemon over a synthetic mirror (kami 1), no default operator. */
async function liveSocket(): Promise<string> {
  const d = new KamiLensDaemon({ dataDir: dir });
  (d.rpc as { blockNumber: () => Promise<number> }).blockNumber = () => new Promise(() => {});
  const m = makeMirror(1_000);
  addKami(m, { index: 1, state: 'RESTING', lastTime: Math.floor(Date.now() / 1000) - 600 });
  const real = d.getStatus.bind(d);
  d.getStatus = () => ({ ...real(), state: 'LIVE', degraded: [] });
  d.getMirror = () => m;
  server = startQuerySocket(d, dir);
  await new Promise((r) => setTimeout(r, 50));
  return socketPath(dir);
}

describe('1.1.1: kami-lens help — the catalog from the registry', () => {
  it('`help` exits 0 and names every query, with node\'s positional attacker', () => {
    const r = cli('help');
    expect(r.status).toBe(0);
    for (const name of ['status', ...QUERY_NAMES]) {
      expect(r.stdout, name).toContain(`usage: kami-lens ${name}`);
    }
    expect(r.stdout).toContain('node <nodeIndex> [attackerKamiIndex]');
    expect(r.stdout).toContain('[--targets <');
    // the client flags and the freshness args, once, at the end
    for (const flag of ['--prose', '--no-authored', '--stateless', '--at-least <block>', '--max-wait <ms>']) {
      expect(r.stdout, flag).toContain(flag);
    }
  }, 60_000);

  it('`--help` and `-h` as the first token print the same catalog', () => {
    const help = cli('help');
    for (const token of ['--help', '-h']) {
      const r = cli(token);
      expect(r.status, token).toBe(0);
      expect(r.stdout, token).toBe(help.stdout);
    }
  }, 60_000);

  it('`node --help` prints node\'s block alone: the positional attacker and --targets', () => {
    const r = cli('node', '--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('usage: kami-lens node <nodeIndex> [attackerKamiIndex]');
    expect(r.stdout).toContain('--targets <');
    expect(r.stdout).toContain('attackerKamiIndex needs --with-vitals');
    expect(r.stdout).not.toContain('usage: kami-lens quests');
  }, 60_000);

  it('`-h` anywhere among a query\'s tokens, and `help <query>`, print the same block', () => {
    const block = cli('node', '--help').stdout;
    expect(block).toContain('usage: kami-lens node <nodeIndex> [attackerKamiIndex]');
    const anywhere = cli('node', '1', '-h');
    expect(anywhere.status).toBe(0);
    expect(anywhere.stdout).toBe(block);
    const named = cli('help', 'node');
    expect(named.status).toBe(0);
    expect(named.stdout).toBe(block);
  }, 60_000);
});

describe('1.1.1: a BAD_ARGS on the CLI path prints its usage line', () => {
  it('the harness spelling of node\'s attacker (O-TS20): the refusal, then node\'s usage, exit 2', () => {
    const r = cli('node', '1', '--with-vitals', '--attacker-kami-index', '1');
    expect(r.status).toBe(2);
    // the logger's own start-up line (pre-existing) is not the CLI's output
    const lines = r.stderr
      .trim()
      .split('\n')
      .filter((l) => !l.startsWith('[logger:'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("unknown option '--attacker-kami-index' for 'node'");
    expect(lines[1]).toBe(`usage: ${reg.usageLine?.('node')}`);
    expect(lines[1]).toContain('usage: kami-lens node <nodeIndex> [attackerKamiIndex]');
  }, 60_000);
});

describe('1.1.1: a parseArgs BAD_ARGS reaches the CLI from the daemon, usage line inside', () => {
  it('node 1 --targets x through the CLI: the daemon\'s JSON refusal carries node\'s usage; exit stays 1', async () => {
    // parseArgs runs in the DAEMON (the CLI is a socket client), so this
    // refusal is the daemon's answer, printed as JSON with exit 1 as through
    // 1.1.0 — the usage line rides in its message. Async spawn: the stub
    // daemon answering it lives in this process.
    await liveSocket();
    const { spawn } = await import('node:child_process');
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', path.join(REPO, 'src', 'cli.ts'), 'node', '1', '--targets', 'x', '--data-dir', dir],
      { cwd: REPO, env: { ...process.env, HOME: dir, NODE_NO_WARNINGS: '1' } }
    );
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c.toString('utf8')));
    const status = await new Promise<number | null>((r) => child.on('close', r));
    const reply = JSON.parse(stdout) as Reply;
    expect(status).toBe(1);
    expect(reply.error?.code).toBe('BAD_ARGS');
    expect(reply.error?.message).toContain("--targets needs comma-separated kami indices, got 'x'");
    expect(reply.error?.message).toContain(` — usage: ${reg.usageLine?.('node')}`);
  }, 60_000);
});

describe('1.1.1: a BAD_ARGS on the SOCKET carries the usage line in its message', () => {
  it('node 1 --targets x: the --targets message AND node\'s usage line', async () => {
    const sock = await liveSocket();
    const r = await ask(sock, { query: 'node', args: ['1', '--targets', 'x'] });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('BAD_ARGS');
    expect(r.error?.message).toContain("--targets needs comma-separated kami indices, got 'x'");
    expect(r.error?.message).toContain(' — usage: kami-lens node <nodeIndex> [attackerKamiIndex]');
  });

  it('quests --accepted with no account: today\'s hint, then the quests usage line', async () => {
    const sock = await liveSocket();
    const r = await ask(sock, { query: 'quests', args: ['--accepted'] });
    expect(r.error?.code).toBe('BAD_ARGS');
    expect(r.error?.message).toContain(
      'a single quest and the open/accepted views are account-relative — name an account index first'
    );
    expect(r.error?.message).toContain(' — usage: kami-lens quests [accountIndex] [questIndex]');
  });

  it('an undeclared option refused by the router gets the same suffix', async () => {
    const sock = await liveSocket();
    const r = await ask(sock, { query: 'node', args: ['1', '--attacker-kami-index', '1'] });
    expect(r.error?.code).toBe('BAD_ARGS');
    expect(r.error?.message).toContain("unknown option '--attacker-kami-index' for 'node'");
    expect(r.error?.message).toContain(` — usage: ${reg.usageLine?.('node')}`);
  });

  it('status gets its own usage line; a non-BAD_ARGS error is untouched', async () => {
    const sock = await liveSocket();
    const s = await ask(sock, { query: 'status', args: ['--at-least', '5'] });
    expect(s.error?.code).toBe('BAD_ARGS');
    expect(s.error?.message).toContain(' — usage: kami-lens status');
    const nf = await ask(sock, { query: 'kami', args: ['2'] });
    expect(nf.error?.code).toBe('NOT_FOUND');
    expect(nf.error?.message).not.toContain('usage:');
  });

  it('an unknown query keeps its have: list and adds a pointer to help, no usage line', async () => {
    const sock = await liveSocket();
    const r = await ask(sock, { query: 'help' });
    expect(r.error?.code).toBe('BAD_ARGS');
    expect(r.error?.message).toContain(`unknown query 'help' (have: ${QUERY_NAMES.join(', ')})`);
    expect(r.error?.message).toContain('; try: kami-lens help');
    expect(r.error?.message).not.toContain('— usage:');
  });
});

describe('1.1.1: every usage line is built from the registry\'s own declarations', () => {
  it('every query declares a usage shape, and its line names every declared argument', () => {
    for (const name of QUERY_NAMES) {
      const def = REGISTRY[name] as unknown as { usage?: { shape?: unknown } };
      expect(typeof def.usage?.shape, name).toBe('string');
      const line = reg.usageLine?.(name) ?? '';
      expect(line.startsWith(`kami-lens ${name}`), name).toBe(true);
      for (const arg of REGISTRY[name].args ?? []) expect(line, `${name} ${arg}`).toContain(`[${arg}`);
      // a VALUED argument prints its placeholder
      for (const arg of REGISTRY[name].valued ?? []) expect(line, `${name} ${arg}`).toMatch(new RegExp(`\\[${arg} <[^>]+>\\]`));
    }
  });

  it('a REQUIRED first positional in the shape is exactly a parseArgs that refuses no positionals', () => {
    for (const name of QUERY_NAMES) {
      const shape = (REGISTRY[name] as unknown as { usage?: { shape?: string } }).usage?.shape ?? '';
      let refuses = false;
      try {
        REGISTRY[name].parseArgs([]);
      } catch (e) {
        refuses = e instanceof QueryError && e.code === 'BAD_ARGS';
      }
      expect(shape.startsWith('<'), `${name}: shape '${shape}', parseArgs([]) refuses: ${refuses}`).toBe(refuses);
    }
  });

  it('the catalog holds status and every query, in registry order', () => {
    const text = (reg.helpCatalog?.() ?? []).join('\n');
    let at = -1;
    for (const name of ['status', ...QUERY_NAMES]) {
      const i = text.indexOf(`usage: kami-lens ${name}`);
      expect(i, name).toBeGreaterThan(at);
      at = i;
    }
  });
});
