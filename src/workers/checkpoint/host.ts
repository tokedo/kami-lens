// kami-lens native module (not a port): the parent side of the checkpoint
// child (0.6.3, divergence 16). DESIGN §3.5, §3.14.
//
// THE DEFECT THIS EXISTS FOR. `StateStore.flush()` does a SYNCHRONOUS
// `v8.serialize` of the whole ~230 MB {header, stores} on the one thread
// that also owns the query socket and every timer, and the periodic
// checkpoint `v8.deserialize`s the stored cache synchronously before it.
// Measured on kami-factory (2026-09-18): the daemon does not answer
// `status` for 20-32 s every ten minutes (4-5 s on the Mac). DESIGN and
// server.ts both say `status` is "the one query that must always answer" —
// and worse, that silence is what the VM watchdog reads as "no status
// answer from a running unit", so it restarts the daemon, and a restart
// there is the SIGTERM-mid-checkpoint of L-8/L-10. A health surface that
// goes blind for 30 s every ten minutes manufactures the outage it is
// watching for.
//
// WHY A CHILD PROCESS AND NOT A WORKER THREAD — the brief asked for
// `node:worker_threads` and this is a deliberate departure, with evidence.
// The port's file bodies are upstream's, which means they import through
// the tsconfig `paths` aliases (swap point 7, DESIGN §4.1): `utils/logger`,
// `engine/encoders`, `clients/kamigaze`. tsx resolves those on a main
// thread and DOES NOT resolve them inside a worker thread — measured here
// on 2026-09-18, three ways (plain `npx tsx`, `--tsconfig`, an execArgv
// `--import tsx` on the Worker, and a `TSX_TSCONFIG_PATH` in the worker's
// env): every one fails with `Cannot find package 'utils' imported from
// …/src/<worker>.ts`, while the identical import resolves on the main
// thread and in a forked child. vitest is the same story by a different
// route: `vite-tsconfig-paths` rewrites what Vite transforms, and a raw
// `new Worker('…/x.ts')` is not that.
//
// So a worker-thread checkpoint would only ever have worked against
// `dist/` — meaning every gate that builds a daemon from source (G1.a,
// G10.a, G10.e, and this release's own hermetic tests) would have exercised
// a DIFFERENT code path than production, and the first proof of the real
// one would have been a live VM. A forked child needs the same
// src-or-dist choice, but both of its branches work: `--import tsx` on the
// src entry, plain node on the packaged bundle.
//
// It is also better at the thing item 4(b) is about. A worker shares the
// process's RSS and its OOM is the daemon's problem; a child's heap is its
// own address space, so the ~2.5 GB of deserialize-plus-serialize moves OUT
// of the daemon's heap cap rather than being carved out of it, and a child
// that dies takes one checkpoint with it and nothing else. The cost is one
// Node start (~150 ms) every ten minutes.

import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { log } from 'utils/logger';
import { findPackageRoot } from '../../version';
import {
  COMMIT_GRACE_MS,
  SHUTDOWN_GRACE_MS,
  shutdownDecision,
  type CheckpointDone,
  type CheckpointJob,
  type CheckpointMessage,
} from './protocol';

/**
 * Heap cap for the child, deliberately (item 4b).
 *
 * What the job holds: the deserialized stores (the ~3.0 M-entry
 * ComponentValues map dominates — the same structure whose resident cost is
 * ~2.3 GB in the daemon) plus the ~230 MB serialize buffer. 4 GB gives that
 * roughly 1.5x headroom without inviting V8 to sit on more than it needs.
 *
 * ON THE COMBINED PEAK. The work MOVES; it is not duplicated. Today the
 * deserialize + delta + serialize happen inside the daemon's own heap, and
 * the VM measured 2.3 GB resting, 3.69 GB at LIVE and 3.83 GB after the
 * first periodic checkpoint — that last 0.14-1.5 GB is precisely what now
 * lives in the child instead. Expect a combined peak near today's single
 * peak plus one V8 isolate's baseline (tens of MB), against a 6144 MB main
 * cap on an 8 GB box. THAT IS A PREDICTION, NOT A MEASUREMENT: gate G10.e
 * records the container's peak RSS across a full checkpoint, and the number
 * belongs in that measurement file rather than in this comment.
 */
export const CHECKPOINT_CHILD_HEAP_MB = 4096;

export type CheckpointHostResult = {
  report: Omit<CheckpointDone, 'kind'>;
  /** wall ms from fork to the report */
  durationMs: number;
};

/** Where the child entry is, in both layouts. Exported so a test and G5.a
 * can assert the packaged path exists rather than discovering it missing at
 * the first checkpoint of a release. */
export function resolveChildEntry(): { entry: string; useTsx: boolean } {
  const root = findPackageRoot();
  if (!root) throw new Error('[checkpoint] cannot locate the kami-lens package root');
  // `import.meta.url` is the honest layout signal: bundled into dist/*.js
  // it ends in .js, and under tsx or vitest this module is still the .ts.
  const fromSource = import.meta.url.endsWith('.ts');
  const entry = fromSource
    ? path.join(root, 'src', 'checkpoint-child.ts')
    : path.join(root, 'dist', 'checkpoint-child.js');
  if (!existsSync(entry)) {
    throw new Error(
      `[checkpoint] child entry missing at ${entry} — a packaging defect (G5.a/G5.b assert it ships)`
    );
  }
  return { entry, useTsx: fromSource };
}

/**
 * Run ONE checkpoint in a child process.
 *
 * Resolves with the report, or rejects. Rejecting is not a crisis: the
 * daemon logs it and the next interval tries again, on a cache that is
 * exactly as it was — which is the same contract the in-process version
 * had.
 */
export class CheckpointHost {
  private child: ChildProcess | null = null;
  private committing = false;
  private startedAtWallMs = 0;

  get inFlight(): boolean {
    return this.child !== null;
  }

  async run(job: CheckpointJob): Promise<CheckpointHostResult> {
    if (this.child) throw new Error('[checkpoint] a checkpoint child is already running');
    const { entry, useTsx } = resolveChildEntry();
    const execArgv = [
      ...(useTsx ? ['--import', 'tsx'] : []),
      `--max-old-space-size=${CHECKPOINT_CHILD_HEAP_MB}`,
    ];
    this.committing = false;
    this.startedAtWallMs = Date.now();

    const child = fork(entry, [], {
      execArgv,
      // the child logs through the same logger; its stdout/stderr are the
      // daemon's, so a checkpoint failure is visible where every other
      // daemon line is
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      cwd: findPackageRoot() ?? process.cwd(),
    });
    this.child = child;
    log.debug('[checkpoint] child forked', { pid: child.pid, entry, execArgv });

    try {
      return await new Promise<CheckpointHostResult>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          fn();
        };

        child.on('message', (raw: unknown) => {
          const message = raw as CheckpointMessage;
          if (message?.kind === 'committing') {
            this.committing = true;
            return;
          }
          if (message?.kind === 'done') {
            const { kind, ...report } = message;
            void kind;
            finish(() => resolve({ report, durationMs: Date.now() - this.startedAtWallMs }));
            return;
          }
          if (message?.kind === 'failed') {
            finish(() => reject(new Error(message.error)));
          }
        });
        child.on('error', (e) => finish(() => reject(e)));
        // An exit BEFORE a message is the interesting case: an OOM kill, a
        // module that failed to load, a `kill` from the shutdown path. It
        // must reject rather than hang the caller's await forever.
        child.on('exit', (code, signal) =>
          finish(() =>
            reject(
              new Error(
                `[checkpoint] child exited without a report (code ${code}, signal ${signal})`
              )
            )
          )
        );
        child.send(job);
      });
    } finally {
      this.child = null;
      this.committing = false;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }

  /**
   * Shutdown protocol (item 4c). Wait for an in-flight checkpoint on the
   * `shutdownDecision` schedule, then kill the child BY ITS OWN PID —
   * never a pattern, never a process group.
   *
   * The file is safe whatever this does: `commitSnapshotFile`'s order means
   * there is no instant with neither a valid primary nor a valid `.prev`.
   * This exists so a completed delta is not thrown away for the sake of
   * saving twenty seconds on a shutdown.
   */
  async drain(
    opts: { graceMs?: number; commitGraceMs?: number; pollMs?: number } = {}
  ): Promise<'idle' | 'finished' | 'killed'> {
    const child = this.child;
    if (!child) return 'idle';
    const graceMs = opts.graceMs ?? SHUTDOWN_GRACE_MS;
    const commitGraceMs = opts.commitGraceMs ?? COMMIT_GRACE_MS;
    const pollMs = opts.pollMs ?? 250;
    log.warn('[checkpoint] shutdown with a checkpoint in flight — waiting', {
      pid: child.pid,
      graceMs,
    });

    for (;;) {
      if (this.child !== child) return 'finished';
      const decision = shutdownDecision({
        elapsedMs: Date.now() - this.startedAtWallMs,
        committing: this.committing,
        graceMs,
        commitGraceMs,
      });
      if (decision === 'kill') break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    if (this.child !== child) return 'finished';
    log.error('[checkpoint] shutdown grace exhausted — killing the checkpoint child', {
      pid: child.pid,
      committing: this.committing,
      elapsedMs: Date.now() - this.startedAtWallMs,
    });
    // by PID, and only the one we forked
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    return 'killed';
  }
}
