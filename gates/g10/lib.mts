// Gate G10 shared library (kami-lens native, not a port).
//
// Three things every G10 leg needs and no existing gate library has:
//
//   1. A LOG TAP. The CDN path's whole audit trail is log lines — `[state]
//      full load served by CDN|gRPC`, `[cdn] load profile`, `[cdn] manifest
//      unavailable`, `[bridge] …` — and utils/logger writes them through
//      console.log/warn/error, so an in-process gate captures them by
//      wrapping those three. Nothing is swallowed: every captured line is
//      still written through to the real console, so a gate run reads
//      normally while it is happening.
//
//   2. A PROGRESS WATCH. daemon.status$ emits on every one of the worker's
//      setLoadingState calls (daemon.ts onSyncStatus always nexts), which is
//      exactly what the pre-LIVE stall watchdog sees. Sampling the same
//      fingerprint it compares — state|percentage|msg|liveBlockNumber — gives
//      the longest SILENT interval of a boot, which is the number that says
//      whether PRELIVE_STALL_MS (90 s) is comfortable or nearly tripped.
//      Divergence 10 in the Worker.ts banner is why this is measured at all.
//
//   3. AN RSS WATCH via `ps`, on a timer. In-process
//      process.memoryUsage().rss would do for the heap, but the number that
//      matters is the one the OS reports, because it is the one the VM's
//      4 GB cap is compared against (RSS 4.9 GB observed 2026-09-17, L-10).
//      Both are recorded; `ps` is the headline.
//
// DATA DIR. Every daemon a G10 leg starts runs on G10_DATA_DIR, default
// gates/.artifacts/g10-data (gitignored, like g1-data). SET G10_DATA_DIR TO
// RUN THE LEGS SOMEWHERE ELSE — a scratch path outside the repo, for
// instance. It must never be a data dir a live daemon owns: these legs
// DELETE it to force a cold boot.

import { execFileSync } from 'node:child_process';
import path from 'node:path';

import type { DaemonStatus, KamiLensDaemon } from '../../src/daemon';
import { REPO_ROOT } from '../g1/lib.mts';

export const G10_DATA_DIR =
  process.env.G10_DATA_DIR ?? path.join(REPO_ROOT, 'gates', '.artifacts', 'g10-data');

/** The production daemon's data dir on this Mac — NEVER written by a gate.
 * G10.b reads its log to compare state counts, and that is all. */
export const PROD_LOG = path.join(
  process.env.HOME ?? '',
  'Library',
  'Logs',
  'kami-lens',
  'daemon.log'
);

// ------------------------------------------------------------------ log tap

export type LogTap = {
  lines: string[];
  stop: () => void;
};

const render = (args: unknown[]): string =>
  args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');

/** Capture console.log/warn/error into an array, passing everything through
 * to the real console so the run stays readable. */
export function tapConsole(): LogTap {
  const lines: string[] = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  const wrap =
    (target: (...a: unknown[]) => void) =>
    (...args: unknown[]) => {
      lines.push(render(args));
      target(...args);
    };
  console.log = wrap(real.log);
  console.warn = wrap(real.warn);
  console.error = wrap(real.error);
  return {
    lines,
    stop: () => {
      console.log = real.log;
      console.warn = real.warn;
      console.error = real.error;
    },
  };
}

/** The ONE line that says which source served the full load, plus its
 * payload object (logged as a second argument, so the captured line is the
 * message followed by the JSON). */
export function fullLoadLine(lines: string[]): { line: string; detail: Record<string, unknown> } | null {
  const hit = [...lines].reverse().find((l) => l.includes('[state] full load served by'));
  if (!hit) return null;
  const brace = hit.indexOf('{');
  let detail: Record<string, unknown> = {};
  if (brace >= 0) {
    try {
      detail = JSON.parse(hit.slice(brace)) as Record<string, unknown>;
    } catch {
      /* the line is still evidence even if the tail did not parse */
    }
  }
  return { line: hit, detail };
}

/** The `[cdn] load profile` numbers, or null on a gRPC load. */
export function loadProfile(lines: string[]): Record<string, unknown> | null {
  const hit = [...lines].reverse().find((l) => l.includes('[cdn] load profile'));
  if (!hit) return null;
  const brace = hit.indexOf('{');
  if (brace < 0) return null;
  try {
    return JSON.parse(hit.slice(brace)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Every line from one prefix, in order — the bridge path taken, the CDN
 * decisions, the manifest refusals. */
export const linesMatching = (lines: string[], needle: string): string[] =>
  lines.filter((l) => l.includes(needle));

// ------------------------------------------------- progress + memory watch

export type BootWatch = {
  /** wall ms from start() to LIVE */
  timeToLiveMs: number;
  /** the longest interval with NO change to the watchdog's fingerprint */
  longestSilentMs: number;
  /** which fingerprint the longest silence sat on — the phase to blame */
  longestSilentOn: string;
  /** every silence over this many ms, in order */
  silencesOverMs: number;
  silences: { ms: number; on: string }[];
  progressSamples: number;
  peakRssKb: number;
  peakHeapRssKb: number;
  rssSamples: number;
};

const fingerprint = (s: DaemonStatus): string =>
  `${s.state}|${s.percentage}|${s.msg}|${s.liveBlockNumber}`;

const rssKb = (): number => {
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(process.pid)], { encoding: 'utf8' });
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
};

/**
 * Start a daemon, watch it to LIVE, and report what the boot cost.
 *
 * Throws on the budget rather than exiting, so the caller can write a
 * measurement for a FAILED boot — which for G10.c (the one gRPC cold boot
 * this gate makes) is the interesting outcome, not a reason to record
 * nothing.
 */
export async function bootAndWatch(
  daemon: KamiLensDaemon,
  opts: { budgetMs: number; reportSilencesOverMs?: number; sampleIntervalMs?: number }
): Promise<BootWatch> {
  const silencesOverMs = opts.reportSilencesOverMs ?? 10_000;
  const sampleIntervalMs = opts.sampleIntervalMs ?? 1_000;

  let lastKey = '';
  let lastAt = Date.now();
  let progressSamples = 0;
  const silences: { ms: number; on: string }[] = [];
  const note = (now: number) => {
    const ms = now - lastAt;
    if (ms >= silencesOverMs) silences.push({ ms, on: lastKey });
  };

  const sub = daemon.status$.subscribe((s) => {
    const key = fingerprint(s);
    if (key === lastKey) return;
    const now = Date.now();
    note(now);
    progressSamples++;
    lastKey = key;
    lastAt = now;
  });

  let peakRssKb = 0;
  let peakHeapRssKb = 0;
  let rssSamples = 0;
  const mem = setInterval(() => {
    rssSamples++;
    peakRssKb = Math.max(peakRssKb, rssKb());
    peakHeapRssKb = Math.max(peakHeapRssKb, Math.round(process.memoryUsage().rss / 1024));
  }, sampleIntervalMs);
  mem.unref?.();

  const t0 = Date.now();
  try {
    await daemon.start();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      daemon.live,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`LIVE not reached within ${opts.budgetMs}ms`)),
          opts.budgetMs
        );
        timer.unref?.();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  } finally {
    // the last stretch before LIVE counts too, and so does the stretch
    // before a failure
    note(Date.now());
    sub.unsubscribe();
    clearInterval(mem);
  }

  const longest = silences.reduce(
    (best, s) => (s.ms > best.ms ? s : best),
    { ms: 0, on: lastKey }
  );
  return {
    timeToLiveMs: Date.now() - t0,
    longestSilentMs: longest.ms,
    longestSilentOn: longest.on,
    silencesOverMs,
    silences,
    progressSamples,
    peakRssKb,
    peakHeapRssKb,
    rssSamples,
  };
}
