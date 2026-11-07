// 1.1.1 (O-TS26): `meta.stale` follows the GATING state, over the real query
// socket (src/server.ts isStale, both call sites — the `status` answer and a
// world read).
//
// Through 1.1.0 `stale` was `state !== 'LIVE' || degraded.length > 0`, and
// the daemon keeps its tripwire COUNTERS in `degraded` for the life of the
// process — so a daemon that took two Kamigaze nonce bumps, reloaded, and sat
// LIVE one block behind with nothing unhealed stamped every answer it served
// for the next day `stale: true`. The flag now keys on the two classes the
// keeper's lens gate keys on (stream-stalled, unhealed-ranges) plus the state;
// `status` itself is unchanged and still carries every entry.
//
// Hermetic: an unstarted daemon whose status is stubbed, a synthetic mirror,
// no network (every chain read hangs and none is awaited).

import { promises as fs } from 'node:fs';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KamiLensDaemon } from '../src/daemon';
import { socketPath, startQuerySocket } from '../src/server';
import { resetSyncHealth } from '../src/sync-health';
import { tripwires, Tripwires } from '../src/tripwires';
import { addKami, makeMirror } from './support/mirror';

type Reply = {
  ok: boolean;
  data?: { degraded?: string[]; tripwires?: Record<string, number> } & Record<string, unknown>;
  meta?: { stale?: boolean } & Record<string, unknown>;
  error?: { code?: string; message?: string };
};

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

let dir = '';
let server: ReturnType<typeof startQuerySocket> | null = null;
const zeroTripwires = () => {
  for (const k of Object.keys(tripwires) as (keyof Tripwires)[]) tripwires[k] = 0;
};
beforeEach(async () => {
  resetSyncHealth();
  zeroTripwires();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kl-stale-'));
});
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  zeroTripwires();
  await fs.rm(dir, { recursive: true, force: true });
});

/** An unstarted daemon over a synthetic mirror holding kami 1, its status
 * stubbed to `state` and (when given) `degraded`. */
function daemonWith(state: string, degraded?: string[]): KamiLensDaemon {
  const d = new KamiLensDaemon({ dataDir: dir });
  (d.rpc as { blockNumber: () => Promise<number> }).blockNumber = () => new Promise(() => {});
  const m = makeMirror(1_000);
  addKami(m, { index: 1, state: 'RESTING', lastTime: Math.floor(Date.now() / 1000) - 600 });
  const real = d.getStatus.bind(d);
  d.getStatus = () =>
    ({ ...real(), state, ...(degraded !== undefined ? { degraded } : {}) }) as ReturnType<typeof real>;
  d.getMirror = () => m;
  return d;
}

async function serve(d: KamiLensDaemon): Promise<string> {
  server = startQuerySocket(d, dir);
  await new Promise((r) => setTimeout(r, 50));
  return socketPath(dir);
}

// [state, degraded, expected meta.stale] — the brief's six, then the edges
const CASES: [string, string[], boolean][] = [
  ['LIVE', ['kamigazeNonceBumps:2'], false],
  ['LIVE', ['stream-stalled:650s'], true],
  ['LIVE', ['unhealed-ranges:1'], true],
  ['LIVE', ['reconcile-stalled:650'], false],
  ['SYNCING', [], true],
  ['LIVE', [], false],
  // every tripwire counter at once is still informational
  [
    'LIVE',
    [
      'unknownComponentIds:1',
      'unknownComponentSchemas:1',
      'decodeFailures:1',
      'kamigazeNonceBumps:1',
      'nonFiniteValues:1',
      'configUnavailable:1',
    ],
    false,
  ],
  // one gating entry among informational ones still gates
  ['LIVE', ['kamigazeNonceBumps:2', 'reconcile-stalled:650', 'unhealed-ranges:3'], true],
  // pre-LIVE: the state decides, whatever the list says
  ['SYNCING', ['pre-live-stall:120s'], true],
  ['STOPPED', [], true],
];

describe('1.1.1: meta.stale on the status answer (call site 1)', () => {
  it.each(CASES)('%s + %j → stale %s', async (state, degraded, expected) => {
    const sock = await serve(daemonWith(state, degraded));
    const reply = await ask(sock, { query: 'status' });
    expect(reply.ok).toBe(true);
    expect(reply.meta?.stale).toBe(expected);
    // status itself is unchanged: every entry stays in `degraded`
    expect(reply.data?.degraded).toEqual(degraded);
  });
});

describe('1.1.1: meta.stale on a world read (call site 2)', () => {
  it.each(CASES.filter(([state]) => state === 'LIVE'))(
    '%s + %j → kami 1 stale %s',
    async (state, degraded, expected) => {
      const sock = await serve(daemonWith(state, degraded));
      const reply = await ask(sock, { query: 'kami', args: ['1'] });
      expect(reply.ok).toBe(true);
      expect(reply.meta?.stale).toBe(expected);
    }
  );

  it('a world read against a daemon that is not LIVE is still NOT_READY (unchanged)', async () => {
    const sock = await serve(daemonWith('SYNCING', []));
    const reply = await ask(sock, { query: 'kami', args: ['1'] });
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('NOT_READY');
  });
});

describe('1.1.1: the real producer — a nonce bump counted by the daemon itself', () => {
  it('kamigazeNonceBumps:2 stays in status.degraded AND status.tripwires, and stamps nothing stale', async () => {
    tripwires.kamigazeNonceBumps = 2;
    const sock = await serve(daemonWith('LIVE'));
    const status = await ask(sock, { query: 'status' });
    expect(status.data?.degraded).toEqual(['kamigazeNonceBumps:2']);
    expect(status.data?.tripwires?.kamigazeNonceBumps).toBe(2);
    expect(status.meta?.stale).toBe(false);
    const kami = await ask(sock, { query: 'kami', args: ['1'] });
    expect(kami.ok).toBe(true);
    expect(kami.meta?.stale).toBe(false);
  });
});

describe('1.1.1: the gating set is the keeper\'s', () => {
  it('STALE_GATING_PREFIXES is exactly kami-keeper 1.0.1 LENS_DEGRADED_GATING_PREFIXES', async () => {
    const mod = (await import('../src/sync-health')) as Record<string, unknown>;
    expect(mod.STALE_GATING_PREFIXES).toEqual(['stream-stalled', 'unhealed-ranges']);
  });
});
