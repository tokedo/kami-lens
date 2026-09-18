// Gate G10.c [live] — the fallback. A CDN URL that cannot serve a manifest
// must degrade to the gRPC cold start, not fail the boot.
//
// THE CONTRACT THIS ASSERTS IS "IT TAKES THE OLD PATH", NOT "THE OLD PATH
// WORKS". The gRPC cold boot is exactly the load Carrot's infra choked on
// five times running on 2026-09-12 (L-6: "UNKNOWN: Response closed without
// headers" at "Querying for State"), which is the whole reason 0.6.2 exists.
// If it fails here the way it failed on the VM, that is RECORDED — with the
// evidence that the fallback was correctly ENTERED — and the gate still
// reports the fallback decision as proven. What would fail this gate is the
// daemon taking the CDN path anyway, or dying without trying gRPC at all.
//
// RUN ONCE, NEVER IN A LOOP. One gRPC cold boot is a ~120 MB stream and
// several minutes of the production snapshot service's attention.
//
// NEVER TOUCHES THE LIVE DAEMONS: its own data dir (G10_DATA_DIR + '-grpc'),
// its own socket, no signals.

import { promises as fs } from 'node:fs';

import { KamiLensDaemon } from '../../src/daemon';
import { fail, pass, writeMeasurement } from '../g1/lib.mts';
import { bootAndWatch, fullLoadLine, G10_DATA_DIR, linesMatching, tapConsole } from './lib.mts';

/** A path under the real CDN host that cannot hold a manifest. Deliberately
 * the real host and not an unroutable one: a DNS failure and a 404 reach
 * fetchManifest by different routes (a thrown TypeError vs `!res.ok`), and
 * the 404 is the one that proves the ok-check, which is the branch a stuck
 * exporter with a live bucket would actually take. */
const DEAD_CDN = 'https://state.prod.kamigotchi.io/does-not-exist';
const DATA_DIR = `${G10_DATA_DIR}-grpc`;
const LIVE_BUDGET_MS = 1_200_000;

await fs.rm(DATA_DIR, { recursive: true, force: true });
await fs.mkdir(DATA_DIR, { recursive: true });
console.log(`[g10.c] data dir ${DATA_DIR}`);
console.log(`[g10.c] dead CDN ${DEAD_CDN}`);

const tap = tapConsole();
const daemon = new KamiLensDaemon({
  dataDir: DATA_DIR,
  stateCdnUrl: DEAD_CDN,
  checkpointIntervalMs: 3_600_000,
});

let reachedLive = true;
let liveError: string | null = null;
let watch: Awaited<ReturnType<typeof bootAndWatch>> | null = null;
try {
  watch = await bootAndWatch(daemon, { budgetMs: LIVE_BUDGET_MS });
} catch (e) {
  reachedLive = false;
  liveError = e instanceof Error ? e.message : String(e);
}
tap.stop();

const served = fullLoadLine(tap.lines);
const cdnLines = linesMatching(tap.lines, '[cdn]');
const manifestRefused = cdnLines.some(
  (l) => l.includes('manifest unavailable') || l.includes('manifest malformed')
);
// the DECISION is what this gate owns: the manifest was refused, and the load
// that ran (if one ran) was the gRPC one. Reaching LIVE is recorded, not
// required — see the header.
const checks: Record<string, boolean> = {
  manifestRefused,
  noCdnLoadAttempted: !cdnLines.some((l) => l.includes('load profile')),
  fellBackToGrpc: served === null ? !reachedLive : served.line.includes('by gRPC'),
};

const record = {
  deadCdnUrl: DEAD_CDN,
  reachedLive,
  liveError,
  timeToLiveMs: watch?.timeToLiveMs ?? null,
  servedLine: served?.line ?? null,
  lastFullLoad: daemon.getStatus().lastFullLoad,
  cdnLines,
  progress: watch
    ? {
        longestSilentMs: watch.longestSilentMs,
        longestSilentOn: watch.longestSilentOn,
        silences: watch.silences,
      }
    : null,
  memory: watch ? { peakRssKb: watch.peakRssKb, peakHeapRssKb: watch.peakHeapRssKb } : null,
  status: daemon.getStatus(),
  checks,
  note:
    'The contract is "a dead CDN takes the gRPC path", not "the gRPC path works". ' +
    'A gRPC cold boot that fails the way L-6 failed on the VM is recorded here as ' +
    'evidence about Kamigaze, not as a fallback defect.',
  match: Object.values(checks).every(Boolean),
};

await daemon.stop();
await writeMeasurement('g10c-cdn-fallback', record);
if (!record.match) fail('G10.c', { checks, cdnLines, servedLine: served?.line ?? null });
pass('G10.c', {
  manifestRefused,
  reachedLive,
  timeToLiveMs: watch?.timeToLiveMs ?? null,
  servedLine: served?.line ?? null,
});
process.exit(0);
