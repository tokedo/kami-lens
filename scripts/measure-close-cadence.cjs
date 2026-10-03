// Read-only: per-UTC-day counts of chain-stream and Kamiden stream closes in
// a kami-lens daemon log (1.0.0, A6). Usage: node scripts/measure-close-cadence.cjs <daemon.log>

const fs = require('fs'), readline = require('readline');
const rl = readline.createInterface({ input: fs.createReadStream(process.argv[2]) });
let day = null; const per = {};
const bump = (k) => { if (!day) return; (per[day] ??= { kgClosed: 0, kgTimeout: 0, kgRate: 0, kgOther: 0, kdClosed: 0, kdOther: 0, statusLines: 0 })[k]++; };
rl.on('line', (l) => {
  const m = /"at":"(\d{4}-\d{2}-\d{2})T/.exec(l);
  if (m) { day = m[1]; bump('statusLines'); return; }
  if (l.startsWith('[kamigaze] resubscribing')) {
    if (/Response closed without grpc-status/.test(l)) bump('kgClosed');
    else if (/Stream timeout/.test(l)) bump('kgTimeout');
    else if (/RESOURCE_EXHAUSTED/.test(l)) bump('kgRate');
    else bump('kgOther');
  } else if (l.startsWith('[kamigaze] rate limited')) bump('kgRate');
  else if (l.startsWith('[kamiden] stream error')) {
    if (/Response closed without grpc-status/.test(l)) bump('kdClosed'); else bump('kdOther');
  }
});
rl.on('close', () => { for (const [d, v] of Object.entries(per).sort()) console.log(d, JSON.stringify(v)); });
