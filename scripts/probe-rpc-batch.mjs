/* global process, fetch, setTimeout, console */
// Read-only probe (A2(a), 2026-10-03). Usage: node scripts/probe-rpc-batch.mjs <out.jsonl> [samples] [spacingMs]
// Phase 2: is a JSON-RPC batch [eth_blockNumber, eth_getLogs, eth_blockNumber]
// served by ONE backend, and does a separate-request head proof over-claim?
// Read-only. Writes JSONL samples + a summary.
import { Interface } from 'ethers';
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
const URL_ = 'https://jsonrpc-yominet-1.anvil.asia-southeast.initia.xyz';
const WORLD = '0x2729174c265dbBd8416C6449E0E813E88f43D0E7';
const abi = JSON.parse(readFileSync(new URL('../src/abi/World.json', import.meta.url), 'utf8')).abi;
const iface = new Interface(abi);
const TOPICS = [[iface.getEvent('ComponentValueSet').topicHash, iface.getEvent('ComponentValueRemoved').topicHash]];
const OUT = process.argv[2] ?? 'p2.jsonl';
const SAMPLES = Number(process.argv[3] ?? 900);
const SPACING = Number(process.argv[4] ?? 2000);
const SPAN = 4;
writeFileSync(OUT, '');
let id = 0;
const hex = (n) => '0x' + n.toString(16);
async function rpc(body) {
  const t0 = Date.now();
  const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  return { j, ms: Date.now() - t0 };
}
const bnReq = () => ({ jsonrpc: '2.0', id: ++id, method: 'eth_blockNumber', params: [] });
const logsReq = (f, t) => ({ jsonrpc: '2.0', id: ++id, method: 'eth_getLogs', params: [{ address: WORLD, fromBlock: hex(f), toBlock: hex(t), topics: TOPICS }] });
const keyOf = (l) => `${parseInt(l.blockNumber, 16)}:${parseInt(l.logIndex, 16)}:${l.transactionHash}`;
const summarize = (logs) => {
  if (!Array.isArray(logs)) return { err: true };
  const blocks = logs.map((l) => parseInt(l.blockNumber, 16));
  return { n: logs.length, maxBlock: blocks.length ? Math.max(...blocks) : null, keys: logs.map(keyOf) };
};
// M3: clamp behaviour for a future toBlock
{
  const { j } = await rpc(bnReq());
  const h = parseInt(j.result, 16);
  const fut = await rpc(logsReq(h - 2, h + 100));
  const futFrom = await rpc(logsReq(h + 50, h + 100));
  const s = summarize(fut.j.result);
  appendFileSync(OUT, JSON.stringify({ kind: 'clamp', head: h, toBlock: h + 100, error: fut.j.error ?? null, n: s.n, maxBlock: s.maxBlock, futureFromError: futFrom.j.error ?? null, futureFromN: Array.isArray(futFrom.j.result) ? futFrom.j.result.length : null }) + '\n');
}
let maxHeadEver = 0;
const pending = [];
async function settle(sample) {
  // reference: two agreeing reads from a batch whose own head is >= to + 10
  for (let attempt = 0; attempt < 6; attempt++) {
    const { j } = await rpc([bnReq(), logsReq(sample.from, sample.to)]);
    const head = parseInt(j[0].result, 16);
    const a = summarize(j[1].result);
    if (head < sample.to + 10 || a.err) { await new Promise((r) => setTimeout(r, 5000)); continue; }
    const { j: j2 } = await rpc(logsReq(sample.from, sample.to));
    const b = summarize(j2.result);
    if (!b.err && a.keys.join() === b.keys.join()) return a;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}
const cmp = (got, ref) => {
  if (got.err) return { status: 'error' };
  const g = new Set(got.keys);
  const missing = ref.keys.filter((k) => !g.has(k));
  const extra = got.keys.filter((k) => !ref.keys.includes(k));
  if (missing.length === 0 && extra.length === 0) return { status: 'complete' };
  const missBlocks = [...new Set(missing.map((k) => +k.split(':')[0]))];
  // block-atomic truncation: every missing log is in a block > got.maxBlock and no block is half-present
  const presentBlocks = new Set(got.keys.map((k) => +k.split(':')[0]));
  const partialBlock = missBlocks.some((b) => presentBlocks.has(b));
  return { status: 'short', missing: missing.length, extra: extra.length, missBlocks, gotMax: got.maxBlock, refMax: ref.maxBlock, partialBlock };
};
let done = 0;
const loop = async () => {
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = Date.now();
    try {
      // 1) the lens's proof: a separate eth_blockNumber
      const p = await rpc(bnReq());
      const H = parseInt(p.j.result, 16);
      maxHeadEver = Math.max(maxHeadEver, H);
      const to = H;
      const from = to - SPAN;
      // 2) the lens's fetch: a separate eth_getLogs
      const A = await rpc(logsReq(from, to));
      // 3) the candidate proof: one batch [bn, logs, bn]
      const B = await rpc([bnReq(), logsReq(from, to), bnReq()]);
      const sample = {
        i, at: new Date().toISOString(), from, to, proofHead: H, maxHeadEver,
        A: summarize(A.j.result), Aerr: A.j.error ?? null, Ams: A.ms,
        Bbn1: parseInt(B.j[0].result, 16), Bbn2: parseInt(B.j[2].result, 16), B: summarize(B.j[1].result), Berr: B.j[1].error ?? null, Bms: B.ms,
      };
      pending.push((async () => {
        await new Promise((r) => setTimeout(r, 30000));
        const ref = await settle(sample);
        const rec = { ...sample };
        if (!ref) rec.ref = null;
        else {
          rec.refN = ref.n; rec.refMax = ref.maxBlock;
          rec.Acmp = cmp(sample.A, ref); rec.Bcmp = cmp(sample.B, ref);
        }
        delete rec.A.keys; delete rec.B.keys;
        appendFileSync(OUT, JSON.stringify(rec) + '\n');
        done++;
      })());
    } catch (e) {
      appendFileSync(OUT, JSON.stringify({ i, error: String(e) }) + '\n');
    }
    const wait = SPACING - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  await Promise.all(pending);
};
await loop();
console.log('done', done);
