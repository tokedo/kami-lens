// kami-lens native module (not a port): the daemon's heap self-sizing
// (0.6.3). DESIGN §3.1, §5; SPEC §3 invariant "the daemon never starts a
// cold load it cannot finish for lack of heap".
//
// THE DEFECT THIS EXISTS FOR, measured 2026-09-18 in gate G5.a. `npm
// install -g kami-lens.tgz` into a clean node:20-slim and `kami-lens
// daemon` with zero config: dead 20 s later, `FATAL ERROR: Ineffective
// mark-compacts near heap limit`, at 2,042 MB, 71.9 % of the way through
// the values apply. A cold boot builds the whole ECS image in memory —
// peak RSS 4.19-4.39 GB on the Mac (g10a/g10c), 3.58-3.83 GB on the VM —
// and Node picks its old-space default from the machine it finds: 2,096 MiB
// in that container, and 4,144 MiB even on a 64 GB Mac. EVERY daemon that
// has ever worked was started with an explicit --max-old-space-size by
// hand (the Mac service at 8192, the VM unit at 4096 then 6144). Nothing
// shipped it, and DESIGN §5's zero-config promise is exactly what the
// launch-prompt test exercises.
//
// WHY A DECISION FUNCTION AND NOT AN `if` AT THE CALL SITE. The rules have
// five inputs and four outcomes, one of which replaces the process image;
// two of them are refusals a user will read at three in the morning, and
// one is a loop guard whose whole job is to be correct on the second pass.
// That is a truth table, so it is written as one, tested as one, and the
// imperative part (read the numbers, log, re-exec) stays a thin shell
// around it.

import v8 from 'node:v8';
import os from 'node:os';
import { readFileSync } from 'node:fs';

/** Documented error marker for refusing to start without enough heap for a
 * cold load (DESIGN §3.1; asserted by gate G5.a). The sibling of
 * ERR_NO_SNAPSHOT_SOURCE, and for the same reason: a boot that is certain
 * to fail must fail NOW and say why, not three minutes in. */
export const ERR_INSUFFICIENT_MEMORY = 'ERR_INSUFFICIENT_MEMORY';

/** Below this, a cold boot is not expected to survive. Measured peak RSS is
 * 4.19-4.39 GB; this is that plus ~15 %, and it is a FLOOR rather than a
 * target because the question it answers is "will this die", not "how fast
 * will it be". */
export const COLD_BOOT_HEAP_FLOOR_MB = 5120;

/** What the daemon gives itself when it is free to choose: the value the VM
 * has been running on since 2026-09-18, proven across a cold CDN boot and
 * the ten-minute checkpoint cycle. Not higher — a cap is not a reservation,
 * but V8 does grow into what it is given, and the same boot measured a
 * LOWER peak under 6144 on the VM (3.58 GB) than under 8192 on the Mac
 * (4.39 GB). */
export const DAEMON_HEAP_TARGET_MB = 6144;

/** A machine this small cannot host this daemon at all, and saying so in
 * one second is the kindest thing available. Below it the arithmetic below
 * would refuse anyway; this branch exists to refuse for the honest reason
 * ("the box is too small") rather than the derived one ("the share of it I
 * may take is under the floor"). */
export const MIN_EFFECTIVE_MEM_MB = 5632;

/** Share of the machine the daemon will take for its heap unaided. It
 * leaves room for the checkpoint child's own heap (workers/checkpoint,
 * measured peak 1.53-1.63 GB), for off-heap buffers, and for whatever else
 * the operator is running. */
export const HEAP_SHARE_OF_MACHINE = 0.75;

/** Set on the re-exec'd process. The loop guard turns on this and nothing
 * else: if it is set and the heap is STILL short, the daemon refuses rather
 * than re-exec a second time. */
export const HEAP_REEXEC_ENV = 'KAMI_LENS_HEAP_REEXEC';

export type HeapSource = 'default' | 'explicit' | 'self-configured';

export type HeapInputs = {
  /** v8.getHeapStatistics().heap_size_limit, in MiB */
  limitMb: number;
  /** the OPERATOR passed --max-old-space-size (NODE_OPTIONS or execArgv) */
  explicit: boolean;
  /** min(os.totalmem(), cgroup limit), in MiB */
  effectiveMemMb: number;
  /** process.execve is available (Node >= 22.15) */
  hasExecve: boolean;
  /** this process is already the product of a re-exec */
  marker: boolean;
};

export type HeapDecision =
  | { action: 'proceed'; source: HeapSource }
  | { action: 'warn-proceed'; source: HeapSource; detail: string }
  | { action: 'reexec'; targetMb: number }
  | { action: 'refuse'; reason: string };

/**
 * What to do about this process's heap, as a total function of five facts.
 *
 * The order of the branches is the policy:
 *
 *   1. enough heap                  -> proceed, whoever arranged it
 *   2. short, and the OPERATOR said so -> warn and proceed. AN EXPLICIT
 *      CHOICE IS NEVER OVERRIDDEN. Someone who writes
 *      --max-old-space-size=2048 may be testing exactly that, and a daemon
 *      that silently disagrees with its operator is worse than one that
 *      dies where it was told to.
 *   3. short, and we ALREADY re-exec'd -> refuse. The loop guard. Reaching
 *      here means the target we chose did not produce the limit we
 *      expected, which is a fact about the machine and not something a
 *      second attempt improves.
 *   4. short, machine too small     -> refuse
 *   5. short, our best share still under the floor -> refuse. Computed
 *      BEFORE re-exec'ing rather than discovered after it: the outcome is
 *      the same refusal either way, and this way it costs no process
 *      restart and lands inside the two-second budget.
 *   6. short, no execve             -> refuse with the remedy
 *   7. otherwise                    -> re-exec with the target
 */
export function decideHeap(input: HeapInputs): HeapDecision {
  const { limitMb, explicit, effectiveMemMb, hasExecve, marker } = input;

  if (limitMb >= COLD_BOOT_HEAP_FLOOR_MB) {
    return { action: 'proceed', source: marker ? 'self-configured' : explicit ? 'explicit' : 'default' };
  }

  if (explicit && !marker) {
    return {
      action: 'warn-proceed',
      source: 'explicit',
      detail:
        `heap limit ${limitMb} MB is below the ${COLD_BOOT_HEAP_FLOOR_MB} MB cold-boot floor, but ` +
        `--max-old-space-size was set explicitly, so it stands. A cold boot builds the whole ECS ` +
        `image in memory (measured peak 4.2-4.4 GB) and will most likely die mid-load; a warm ` +
        `restart from a saved cache needs about 2.3 GB and should be fine.`,
    };
  }

  if (marker) {
    return {
      action: 'refuse',
      reason:
        `re-exec'd with --max-old-space-size and the heap limit is still ${limitMb} MB, below the ` +
        `${COLD_BOOT_HEAP_FLOOR_MB} MB cold-boot floor. Refusing rather than re-exec again. ` +
        `Start the daemon with an explicit NODE_OPTIONS=--max-old-space-size=${DAEMON_HEAP_TARGET_MB} ` +
        `and it will be respected as-is.`,
    };
  }

  if (effectiveMemMb < MIN_EFFECTIVE_MEM_MB) {
    return {
      action: 'refuse',
      reason:
        `this machine has ${effectiveMemMb} MB available to the process and a cold boot needs a ` +
        `${COLD_BOOT_HEAP_FLOOR_MB} MB JS heap on top of off-heap buffers (measured peak RSS ` +
        `4.2-4.4 GB). Refusing to start a load that cannot finish. Run the daemon on a machine ` +
        `with at least 8 GB, or point it at a data directory holding a warm cache and set ` +
        `NODE_OPTIONS=--max-old-space-size to a value you have tested.`,
    };
  }

  const targetMb = Math.min(
    DAEMON_HEAP_TARGET_MB,
    Math.floor(effectiveMemMb * HEAP_SHARE_OF_MACHINE)
  );

  if (targetMb < COLD_BOOT_HEAP_FLOOR_MB) {
    return {
      action: 'refuse',
      reason:
        `the most heap this daemon will take unaided is ${targetMb} MB ` +
        `(${Math.round(HEAP_SHARE_OF_MACHINE * 100)}% of the ${effectiveMemMb} MB available to ` +
        `it), which is below the ${COLD_BOOT_HEAP_FLOOR_MB} MB cold-boot floor. The rest is left ` +
        `for the checkpoint child's own heap and for everything else on the box. Refusing to ` +
        `start a load that cannot finish. Either give it a bigger machine, or set ` +
        `NODE_OPTIONS=--max-old-space-size explicitly and own the outcome — an explicit value is ` +
        `always respected.`,
    };
  }

  if (!hasExecve) {
    return {
      action: 'refuse',
      reason:
        `heap limit ${limitMb} MB is below the ${COLD_BOOT_HEAP_FLOOR_MB} MB cold-boot floor and ` +
        `this Node (${process.version}) cannot raise it in place — process.execve arrived in ` +
        `22.15. Start it with the cap instead:\n\n` +
        `    NODE_OPTIONS=--max-old-space-size=${DAEMON_HEAP_TARGET_MB} kami-lens daemon\n`,
    };
  }

  return { action: 'reexec', targetMb };
}

// ----------------------------------------------------- reading the facts

/** The heap cap V8 is actually enforcing on this process, in MiB. */
export const heapLimitMb = (): number =>
  Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024);

/** Did the OPERATOR ask for a heap size? Both channels count: NODE_OPTIONS
 * (what a unit file or a Dockerfile uses) and execArgv (what a command line
 * uses). Our own re-exec puts it in execArgv too, which is why the marker
 * and not this is what tells the two apart. */
export const heapExplicit = (env: NodeJS.ProcessEnv = process.env, argv = process.execArgv): boolean =>
  /--max[-_]old[-_]space[-_]size/.test(env.NODE_OPTIONS ?? '') ||
  argv.some((a) => /^--max[-_]old[-_]space[-_]size/.test(a));

/**
 * Memory actually available to this process, in MiB: the machine's RAM, or
 * the cgroup's cap when one applies and is readable.
 *
 * THE CGROUP IS THE ONE THAT MATTERS IN PRODUCTION. `os.totalmem()` reports
 * the HOST's memory inside a container, so a 6 GB container on a 64 GB host
 * would otherwise size itself as if it had 64 GB and get killed by the
 * cgroup instead of by V8 — a less legible death, and one this daemon has
 * no excuse for after G5.a. v2 (`memory.max`, which reads `max` when
 * unlimited) is tried first, then v1 (`memory.limit_in_bytes`, which
 * reports a sentinel near 2^63 when unlimited).
 */
export function effectiveMemMb(): number {
  const totalMb = Math.floor(os.totalmem() / 1024 / 1024);
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = readFileSync(path, 'utf8').trim();
      if (raw === 'max') continue;
      const bytes = Number(raw);
      if (!Number.isFinite(bytes) || bytes <= 0) continue;
      const cgroupMb = Math.floor(bytes / 1024 / 1024);
      // a cgroup "limit" larger than the machine is the unlimited sentinel
      if (cgroupMb > 0 && cgroupMb < totalMb) return cgroupMb;
    } catch {
      /* not containerised, or the file is not readable — host memory it is */
    }
  }
  return totalMb;
}

export const readHeapInputs = (): HeapInputs => ({
  limitMb: heapLimitMb(),
  explicit: heapExplicit(),
  effectiveMemMb: effectiveMemMb(),
  hasExecve: typeof (process as { execve?: unknown }).execve === 'function',
  marker: process.env[HEAP_REEXEC_ENV] === '1',
});

/** What `status.heap.source` should say for a process that got past the
 * decision. Derived from the same two facts the decision uses, so the
 * served value cannot drift from the branch that produced it. */
export const heapSource = (): HeapSource =>
  process.env[HEAP_REEXEC_ENV] === '1' ? 'self-configured' : heapExplicit() ? 'explicit' : 'default';
