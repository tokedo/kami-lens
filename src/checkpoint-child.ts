// kami-lens native module (not a port): the checkpoint child's entry point
// (0.6.3, divergence 16). DESIGN §3.5.
//
// WHY THIS FILE IS AT THE TOP OF src/ AND NOT BESIDE ITS JOB. It is a
// PROCESS ENTRY, so tsup must emit it as its own bundle — and tsup derives
// output paths from the common ancestor of its entries, so a flat entry
// here lands at exactly dist/checkpoint-child.js, which is the path
// workers/checkpoint/host.ts resolves against the package root. Keeping it
// flat is what keeps that resolution a constant rather than a guess about
// how a bundler laid out a directory. (`files: ["dist"]` in package.json
// already ships it; G5.a/G5.b assert the packaged daemon can run it.)
//
// It does three things and nothing else: read the job off the IPC channel,
// run it, answer once. Everything interesting is in workers/checkpoint/.

import { log } from 'utils/logger';
import { runCheckpointJob, validateJob } from 'workers/checkpoint/job';
import type { CheckpointJob, CheckpointMessage } from 'workers/checkpoint/protocol';

/**
 * Answer the parent, and RESOLVE ONLY ONCE THE MESSAGE HAS FLUSHED.
 *
 * `process.send` is asynchronous and `process.disconnect()` nulls the
 * channel underneath it: disconnecting straight after a send made the child
 * die with `TypeError: Cannot set properties of null (setting
 * Symbol(kPendingMessages))` in node:internal/child_process — after the
 * parent had already received the report, so the checkpoint SUCCEEDED and
 * printed a crash trace every ten minutes anyway. The callback is what
 * makes "sent" mean sent.
 */
const send = (message: CheckpointMessage): Promise<void> =>
  new Promise<void>((resolve) => {
    // `process.send` exists only under fork(); a child started any other
    // way has nothing to answer and says so on stderr rather than
    // pretending.
    if (!process.send) {
      log.error(
        '[checkpoint:child] no IPC channel — this entry is spawned by the daemon, not by hand'
      );
      process.exitCode = 2;
      resolve();
      return;
    }
    process.send(message, undefined, undefined, () => resolve());
  });

let peakRssKb = 0;
const sampler = setInterval(() => {
  peakRssKb = Math.max(peakRssKb, Math.round(process.memoryUsage().rss / 1024));
}, 1_000);
sampler.unref();

process.on('message', (raw: unknown) => {
  void (async () => {
    try {
      const job: CheckpointJob = validateJob(raw as Partial<CheckpointJob>);
      const report = await runCheckpointJob(job, undefined, () => void send({ kind: 'committing' }));
      peakRssKb = Math.max(peakRssKb, Math.round(process.memoryUsage().rss / 1024));
      await send({ kind: 'done', ...report, peakRssKb });
    } catch (e) {
      await send({ kind: 'failed', error: e instanceof Error ? e.message : String(e) });
    } finally {
      clearInterval(sampler);
      // Never process.exit() here: the report is the whole point of this
      // process and exiting is how it would be lost. Disconnecting closes
      // the one ref'd handle left, so the loop empties and the child exits
      // on its own — which is also what lets the parent read 'exit' without
      // a message as a real failure.
      process.disconnect?.();
    }
  })();
});
