// Gate G3.e [live] — degraded-state honesty. The daemon is pointed at a
// local pass-through proxy in front of the real Kamigaze; once LIVE, the
// proxy is killed mid-session (the unreachable-URL moment). Assertions,
// scripted on status JSON over the query socket:
//   1. within one stall interval (STREAM_STALL_MS = 60 s) plus slack, the
//      status reports the degraded state ('stream-stalled' marker);
//   2. queries still serve last-synced state and stamp it stale
//      (meta.stale = true, data non-empty).

import { createServer as createHttpServer, request as httpsRequest } from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import path from 'node:path';

import { ARTIFACTS_DIR, REPO_ROOT, fail, pass, sleep, writeMeasurement } from '../g1/lib.mts';

void httpsRequest; // (import kept for symmetry; https module is used below)

const DATA_DIR = path.join(ARTIFACTS_DIR, 'overnight-data');
const SOCK = path.join(DATA_DIR, 'kami-lens.sock');
const UPSTREAM = 'api.prod.kamigotchi.io';
const PROXY_PORT = 18923;

// --- 1. pass-through proxy ---------------------------------------------------
const proxy = createHttpServer((req, res) => {
  const upstreamReq = https.request(
    { host: UPSTREAM, port: 443, path: req.url, method: req.method, headers: { ...req.headers, host: UPSTREAM } },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstreamReq.on('error', () => {
    res.statusCode = 502;
    res.end();
  });
  req.pipe(upstreamReq);
});
await new Promise<void>((resolve) => proxy.listen(PROXY_PORT, '127.0.0.1', resolve));
console.log(`[g3.e] proxy 127.0.0.1:${PROXY_PORT} → ${UPSTREAM}`);

// --- 2. daemon through the proxy --------------------------------------------
const daemon = spawn('npx', ['tsx', '--tsconfig', 'tsconfig.json', 'src/cli.ts', 'daemon'], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    KAMI_LENS_DATA_DIR: DATA_DIR,
    KAMI_LENS_KAMIGAZE_URL: `http://127.0.0.1:${PROXY_PORT}`,
    NODE_OPTIONS: '--max-old-space-size=8192',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let live = false;
daemon.stdout.on('data', (d: Buffer) => {
  if (d.toString().includes('"state":"LIVE"')) live = true;
});
const daemonExit = new Promise<number | null>((resolve) => daemon.on('close', resolve));
for (let i = 0; i < 300 && !live; i++) await sleep(1000);
if (!live) {
  daemon.kill('SIGKILL');
  proxy.close();
  fail('G3.e', { reason: 'daemon did not reach LIVE through the proxy within 300 s' });
}
console.log('[g3.e] LIVE through proxy; letting the stream run 15 s');
await sleep(15_000);

function socketQuery(query: string, args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = connect(SOCK);
    let buffer = '';
    conn.on('connect', () => conn.write(JSON.stringify({ id: 1, query, args }) + '\n'));
    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl >= 0) {
        conn.end();
        resolve(JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>);
      }
    });
    conn.on('error', reject);
  });
}

type StatusResp = { ok: boolean; data: { state: string; streamSilentMs: number; degraded: string[] }; meta: { stale: boolean } };
const before = (await socketQuery('status', [])) as unknown as StatusResp;

// --- 3. kill the proxy mid-session ------------------------------------------
proxy.close();
proxy.closeAllConnections?.();
const killedAt = Date.now();
console.log('[g3.e] proxy killed — Kamigaze now unreachable');

// --- 4. degraded within one stall interval (+30 s slack) --------------------
let degradedAtMs: number | null = null;
let after: StatusResp | null = null;
for (let i = 0; i < 95; i++) {
  await sleep(1000);
  after = (await socketQuery('status', [])) as unknown as StatusResp;
  if (after.data.degraded.some((d) => d.startsWith('stream-stalled'))) {
    degradedAtMs = Date.now() - killedAt;
    break;
  }
}

// --- 5. queries still serve, stamped stale ----------------------------------
const kamiResp = (await socketQuery('kami', ['10016'])) as unknown as {
  ok: boolean;
  data: { index: number };
  meta: { stale: boolean };
};

daemon.kill('SIGTERM');
await daemonExit;

const checks = {
  liveThroughProxy: live,
  notDegradedBefore: !before.data.degraded.some((d) => d.startsWith('stream-stalled')),
  degradedWithinInterval: degradedAtMs !== null && degradedAtMs <= 90_000,
  statusStaleAfter: after?.meta.stale === true,
  queryStillServes: kamiResp.ok && kamiResp.data.index === 10016,
  queryStampedStale: kamiResp.meta.stale === true,
};
const ok = Object.values(checks).every(Boolean);

await writeMeasurement('g3e-degraded', {
  stallIntervalMs: 60_000,
  degradedAfterMs: degradedAtMs,
  degradedMarkers: after?.data.degraded ?? [],
  checks,
  match: ok,
});

if (!ok) fail('G3.e', { reason: 'degraded honesty failed', checks, degradedAtMs });
pass('G3.e', { degradedAfterMs: degradedAtMs, checks });
process.exit(0);
