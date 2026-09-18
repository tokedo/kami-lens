// Gate G10.e's in-container status poller (plain CJS, no dependencies — it
// runs inside the packaged image under bare `node`, where tsx and this
// repo's tsconfig do not exist).
//
// WHY IT POLLS THE SOCKET AND NOT THE CLI. `docker exec kami-lens status`
// is a fresh Node process loading a 1.5 MB bundle, measured at 1.1-3.2 s
// per call on a loaded box — on a 1-CPU container it would BE the
// contention it is trying to measure, and a 2 s bound cannot be asserted
// with a 3 s instrument. This opens one connection per sample and speaks
// the socket's line protocol directly, which is what the VM watchdog and
// the container healthcheck effectively do.
//
// One JSONL line per sample to --out. The host reads the file, so the poll
// loop never blocks on a pipe:
//   {t, latencyMs, ok, state, percentage, msg, liveBlockNumber,
//    checkpointInFlight, checkpointBlock, error}
//
// `timeoutMs` is what makes a sample a MEASUREMENT rather than a wait: a
// daemon that does not answer inside it records ok:false with the timeout
// as its latency, which is the number the gate's "longest unanswered gap"
// is derived from.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};

const dataDir = argOf('--data-dir', '/data');
const out = argOf('--out', '/tmp/g10e-poll.jsonl');
const intervalMs = Number(argOf('--interval-ms', '1000'));
const timeoutMs = Number(argOf('--timeout-ms', '10000'));
const sock = path.join(dataDir, 'kami-lens.sock');

const write = (row) => {
  try {
    fs.appendFileSync(out, JSON.stringify(row) + '\n');
  } catch {
    /* the host reads whatever landed; a failed append must not kill the poll */
  }
};

function sample() {
  return new Promise((resolve) => {
    const started = Date.now();
    let buffer = '';
    let settled = false;
    const done = (row) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        conn.destroy();
      } catch {
        /* already gone */
      }
      resolve({ t: new Date(started).toISOString(), latencyMs: Date.now() - started, ...row });
    };
    const conn = net.createConnection(sock);
    const timer = setTimeout(() => done({ ok: false, error: `timeout after ${timeoutMs}ms` }), timeoutMs);
    conn.on('connect', () => conn.write(JSON.stringify({ id: 1, query: 'status' }) + '\n'));
    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      let parsed;
      try {
        parsed = JSON.parse(buffer.slice(0, nl));
      } catch (e) {
        done({ ok: false, error: `unparseable answer: ${String(e)}` });
        return;
      }
      if (!parsed.ok) {
        done({ ok: false, error: JSON.stringify(parsed.error ?? null) });
        return;
      }
      const d = parsed.data ?? {};
      done({
        ok: true,
        state: d.state ?? null,
        percentage: d.percentage ?? null,
        msg: d.msg ?? null,
        liveBlockNumber: d.liveBlockNumber ?? null,
        bootstrapMode: d.bootstrapMode ?? null,
        startedAt: d.startedAt ?? null,
        liveAt: d.liveAt ?? null,
        // §3.5 (0.6.3) — the field this leg exists to exercise
        checkpointInFlight: d.checkpoint ? d.checkpoint.inFlight === true : null,
        checkpointBlock: d.checkpoint ? (d.checkpoint.blockNumber ?? null) : null,
        checkpointCount: d.checkpointCount ?? null,
        lastFullLoad: d.lastFullLoad ?? null,
        degraded: d.degraded ?? null,
      });
    });
    conn.on('error', (e) => done({ ok: false, error: String(e.message || e) }));
    conn.on('close', () => done({ ok: false, error: 'closed without an answer' }));
  });
}

(async () => {
  for (;;) {
    const row = await sample();
    write(row);
    const rest = intervalMs - row.latencyMs;
    if (rest > 0) await new Promise((r) => setTimeout(r, rest));
  }
})();
