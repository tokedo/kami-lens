/* global process, fetch, setTimeout, console */
// Read-only probe (A2(a), 2026-10-03). Usage: node scripts/probe-rpc-heads.mjs [N]
// Phase 1: head consistency across separate requests and inside one batch.
const URL_ = 'https://jsonrpc-yominet-1.anvil.asia-southeast.initia.xyz';
let id = 0;
async function rpc(body) {
  const t0 = Date.now();
  const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  return { j, ms: Date.now() - t0, h: r.headers.get('x-envoy-upstream-service-time') };
}
const one = () => ({ jsonrpc: '2.0', id: ++id, method: 'eth_blockNumber', params: [] });
const N = Number(process.argv[2] ?? 300);
let maxSeen = 0, regress = [], vals = [];
for (let i = 0; i < N; i++) {
  const { j } = await rpc(one());
  const v = parseInt(j.result, 16);
  if (v < maxSeen) regress.push(maxSeen - v);
  maxSeen = Math.max(maxSeen, v);
  vals.push(v);
  await new Promise((r) => setTimeout(r, 100));
}
let inBatchDisagree = 0, spreads = [];
for (let i = 0; i < N; i++) {
  const { j } = await rpc([one(), one(), one(), one()]);
  const vs = j.map((x) => parseInt(x.result, 16));
  const s = Math.max(...vs) - Math.min(...vs);
  if (s > 0) { inBatchDisagree++; spreads.push(s); }
  await new Promise((r) => setTimeout(r, 100));
}
const hist = (a) => a.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
console.log(JSON.stringify({ at: new Date().toISOString(), N, singleRequestRegressions: regress.length, regressionDepthHist: hist(regress), batchOf4WithDisagreement: inBatchDisagree, batchSpreadHist: hist(spreads), firstHead: vals[0], lastHead: vals[vals.length - 1] }));
