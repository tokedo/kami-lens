// A5 + A7 over the real query socket (src/server.ts startQuerySocket):
//   - `status` answers without waiting on the chain (A7): the head comes from
//     the background sample, and a stalled RPC cannot hold the answer;
//   - `--at-least` holds a world read until appliedThrough reaches the block,
//     and refuses NOT_APPLIED carrying appliedThrough when it does not (A5).

import { promises as fs } from 'node:fs';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KamiLensDaemon } from '../src/daemon';
import { socketPath, startQuerySocket } from '../src/server';
import { resetSyncHealth, syncHealth } from '../src/sync-health';
import { addKami, makeMirror } from './support/mirror';

type Reply = { ok: boolean; data?: Record<string, unknown>; meta?: Record<string, unknown>; error?: Record<string, unknown> };

function ask(sock: string, req: Record<string, unknown>): Promise<{ reply: Reply; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const conn = connect(sock);
    let buf = '';
    conn.on('connect', () => conn.write(JSON.stringify({ id: 1, ...req }) + '\n'));
    conn.on('data', (c) => {
      buf += c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      conn.end();
      resolve({ reply: JSON.parse(buf.slice(0, nl)) as Reply, ms: Date.now() - t0 });
    });
    conn.on('error', reject);
  });
}

let dir = '';
let server: ReturnType<typeof startQuerySocket> | null = null;
beforeEach(async () => {
  resetSyncHealth();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kl-sock-'));
});
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  await fs.rm(dir, { recursive: true, force: true });
});

/** An unstarted daemon whose chain reads NEVER answer, shown as LIVE over a
 * synthetic mirror. */
function liveDaemon() {
  const d = new KamiLensDaemon({ dataDir: dir });
  (d.rpc as { blockNumber: () => Promise<number> }).blockNumber = () => new Promise(() => {});
  const m = makeMirror(1_234);
  addKami(m, { index: 42, state: 'RESTING', lastTime: Math.floor(Date.now() / 1000) - 600 });
  const real = d.getStatus.bind(d);
  d.getStatus = () => ({ ...real(), state: 'LIVE', degraded: [] });
  d.getMirror = () => m;
  return d;
}

describe('A7: status does no network I/O on its request path', () => {
  it('answers at once although every chain read hangs, and serves the background head sample', async () => {
    const d = liveDaemon();
    d.headSample = { blockNumber: 5_000, sampledAt: new Date().toISOString(), sampledAtWallMs: Date.now() };
    server = startQuerySocket(d, dir);
    await new Promise((r) => setTimeout(r, 50));
    const { reply, ms } = await ask(socketPath(dir), { query: 'status' });
    expect(reply.ok).toBe(true);
    expect(ms).toBeLessThan(500);
    expect(reply.data?.headBlockNumber).toBe(5_000);
  });

  it('a sample older than 60 s is not served: the three head fields are absent together', async () => {
    const d = liveDaemon();
    d.headSample = { blockNumber: 5_000, sampledAt: new Date().toISOString(), sampledAtWallMs: Date.now() - 61_000 };
    server = startQuerySocket(d, dir);
    await new Promise((r) => setTimeout(r, 50));
    const { reply } = await ask(socketPath(dir), { query: 'status' });
    expect(reply.data).not.toHaveProperty('headBlockNumber');
    expect(reply.data).not.toHaveProperty('headSampledAt');
    expect(reply.data).not.toHaveProperty('blockLag');
  });
});

describe('A5: --at-least on the socket', () => {
  it('serves at once when the block is applied, with meta.appliedThrough', async () => {
    syncHealth.appliedThrough = 1_234;
    server = startQuerySocket(liveDaemon(), dir);
    await new Promise((r) => setTimeout(r, 50));
    const { reply } = await ask(socketPath(dir), { query: 'kami', args: ['42', '--at-least', '1234'] });
    expect(reply.ok).toBe(true);
    expect(reply.meta?.appliedThrough).toBe(1_234);
  });

  it('refuses NOT_APPLIED with the current appliedThrough after --max-wait', async () => {
    syncHealth.appliedThrough = 1_200;
    server = startQuerySocket(liveDaemon(), dir);
    await new Promise((r) => setTimeout(r, 50));
    const { reply, ms } = await ask(socketPath(dir), {
      query: 'kami',
      args: ['42', '--at-least', '1300', '--max-wait', '150'],
    });
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatchObject({ code: 'NOT_APPLIED', appliedThrough: 1_200 });
    expect(ms).toBeGreaterThanOrEqual(140);
    expect(ms).toBeLessThan(1_500);
  });

  it('BAD_ARGS for a wait above the cap — the per-query vocabulary check still runs', async () => {
    server = startQuerySocket(liveDaemon(), dir);
    await new Promise((r) => setTimeout(r, 50));
    const a = await ask(socketPath(dir), { query: 'kami', args: ['42', '--at-least', '1', '--max-wait', '30001'] });
    expect(a.reply.error).toMatchObject({ code: 'BAD_ARGS' });
    const b = await ask(socketPath(dir), { query: 'kami', args: ['42', '--at-least', '1', '--bogus'] });
    expect(b.reply.error).toMatchObject({ code: 'BAD_ARGS' });
  });
});

describe('1.0.0: a client that disconnects releases its --at-least wait', () => {
  it('the wait ends at the disconnect, not at --max-wait, and nothing is written back', async () => {
    const d = liveDaemon();
    syncHealth.appliedThrough = 1_000;
    server = startQuerySocket(d, dir);
    await new Promise((r) => setTimeout(r, 50));
    const conn = connect(socketPath(dir));
    await new Promise<void>((r) => conn.on('connect', () => r()));
    conn.write(
      JSON.stringify({ id: 9, query: 'kami', args: ['42', '--at-least', '5000', '--max-wait', '30000'] }) + '\n'
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(d.waitsCancelled).toBe(0);
    const t0 = Date.now();
    conn.destroy();
    // released promptly — not 30 s later
    for (let i = 0; i < 50 && d.waitsCancelled === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(d.waitsCancelled).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('a request queued behind the wait on the same connection is never run', async () => {
    const d = liveDaemon();
    syncHealth.appliedThrough = 1_000;
    let served = 0;
    const realMirror = d.getMirror;
    d.getMirror = () => {
      served++;
      return realMirror();
    };
    server = startQuerySocket(d, dir);
    await new Promise((r) => setTimeout(r, 50));
    const conn = connect(socketPath(dir));
    await new Promise<void>((r) => conn.on('connect', () => r()));
    conn.write(JSON.stringify({ id: 1, query: 'kami', args: ['42', '--at-least', '5000'] }) + '\n');
    conn.write(JSON.stringify({ id: 2, query: 'kami', args: ['42'] }) + '\n');
    await new Promise((r) => setTimeout(r, 100));
    conn.destroy();
    await new Promise((r) => setTimeout(r, 200));
    expect(d.waitsCancelled).toBe(1);
    expect(served).toBe(0);
  });

  it('a waiter whose client stays answers normally (the signal is per connection)', async () => {
    const d = liveDaemon();
    syncHealth.appliedThrough = 1_000;
    server = startQuerySocket(d, dir);
    await new Promise((r) => setTimeout(r, 50));
    const { reply } = await ask(socketPath(dir), { query: 'kami', args: ['42', '--at-least', '900'] });
    expect(reply.ok).toBe(true);
    expect(d.waitsCancelled).toBe(0);
  });
});
