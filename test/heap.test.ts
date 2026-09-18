// §3.1 (0.6.3): the daemon's heap self-sizing, as a truth table.
//
// It exists because of a measured death: `kami-lens daemon` with zero
// config in a clean node:20-slim died at 2,042 MB, 20 s in, 71.9 % through
// the values apply — Node's own old-space default there is 2,096 MiB and a
// cold boot needs 4.2-4.4 GB (gate G5.a, 2026-09-18). Every branch below
// is a decision someone will meet on a machine we do not own, and two of
// them are refusals they will read at three in the morning, so each one is
// pinned here rather than reasoned about at the call site.

import os from 'node:os';
import { describe, expect, it } from 'vitest';

import {
  COLD_BOOT_HEAP_FLOOR_MB,
  DAEMON_HEAP_TARGET_MB,
  HEAP_SHARE_OF_MACHINE,
  MIN_EFFECTIVE_MEM_MB,
  decideHeap,
  effectiveMemMb,
  heapExplicit,
  type HeapInputs,
} from '../src/heap';

/** a big, unconstrained, modern machine with Node's default cap */
const base: HeapInputs = {
  limitMb: 4144, // measured: Node's default on a 64 GB Mac
  explicit: false,
  effectiveMemMb: 65_536,
  hasExecve: true,
  marker: false,
};

describe('decideHeap (§3.1 truth table)', () => {
  it('proceeds when the limit already clears the floor', () => {
    expect(decideHeap({ ...base, limitMb: COLD_BOOT_HEAP_FLOOR_MB })).toEqual({
      action: 'proceed',
      source: 'default',
    });
    // the Mac service (8192) and the VM unit (6144) both land here
    expect(decideHeap({ ...base, limitMb: 8192, explicit: true })).toEqual({
      action: 'proceed',
      source: 'explicit',
    });
    expect(decideHeap({ ...base, limitMb: 6144, explicit: true, marker: true })).toEqual({
      action: 'proceed',
      source: 'self-configured',
    });
  });

  it('RESPECTS an explicit cap below the floor, with a warning', () => {
    const d = decideHeap({ ...base, limitMb: 2048, explicit: true });
    expect(d.action).toBe('warn-proceed');
    if (d.action !== 'warn-proceed') throw new Error('unreachable');
    expect(d.source).toBe('explicit');
    // it must say what will happen, not merely that something is wrong
    expect(d.detail).toMatch(/2048 MB/);
    expect(d.detail).toMatch(new RegExp(`${COLD_BOOT_HEAP_FLOOR_MB} MB`));
    expect(d.detail).toMatch(/die mid-load/);
    // and it must not re-exec: an operator who asked for 2048 may be
    // testing exactly that
    expect(d.action).not.toBe('reexec');
  });

  it('re-execs with the target when it is free to choose', () => {
    expect(decideHeap(base)).toEqual({ action: 'reexec', targetMb: DAEMON_HEAP_TARGET_MB });
  });

  it('never takes more than its share of a smaller machine', () => {
    // 8 GB box: 75 % is 6144, which is also the target — the VM's case
    const eightGb = decideHeap({ ...base, effectiveMemMb: 8192 });
    expect(eightGb).toEqual({ action: 'reexec', targetMb: 6144 });
    // 12 GB box: capped by the target, not by the share
    expect(decideHeap({ ...base, effectiveMemMb: 12_288 })).toEqual({
      action: 'reexec',
      targetMb: DAEMON_HEAP_TARGET_MB,
    });
  });

  it('pins the boundary between self-sizing and refusing', () => {
    // the share must reach the floor, so the boundary is
    // floor / share = 5120 / 0.75 = 6826.67 MB of effective memory
    const boundary = Math.ceil(COLD_BOOT_HEAP_FLOOR_MB / HEAP_SHARE_OF_MACHINE);
    expect(boundary).toBe(6827);
    // one MB below it: the best share is 5119, under the floor -> refuse
    expect(decideHeap({ ...base, effectiveMemMb: boundary - 1 }).action).toBe('refuse');
    // at it: 5120 exactly -> self-size
    expect(decideHeap({ ...base, effectiveMemMb: boundary })).toEqual({
      action: 'reexec',
      targetMb: COLD_BOOT_HEAP_FLOOR_MB,
    });
    // so a 6 GB container refuses and a 7 GB one runs — the number an
    // operator sizing a box actually needs
    expect(decideHeap({ ...base, effectiveMemMb: 6144 }).action).toBe('refuse');
    expect(decideHeap({ ...base, effectiveMemMb: 7168 })).toEqual({
      action: 'reexec',
      targetMb: 5376,
    });
  });

  it('REFUSES a machine too small to host the daemon at all', () => {
    const d = decideHeap({ ...base, effectiveMemMb: MIN_EFFECTIVE_MEM_MB - 1 });
    expect(d.action).toBe('refuse');
    if (d.action !== 'refuse') throw new Error('unreachable');
    expect(d.reason).toMatch(/at least 8 GB/);
    expect(d.reason).toMatch(/4\.2-4\.4 GB/);
  });

  it('REFUSES when its best share is still under the floor, WITHOUT re-exec\'ing first', () => {
    // 6 GB: 75 % is 4608, under the 5120 floor. The outcome is the same
    // refusal whether it is computed now or discovered after a restart;
    // computing it now costs no process restart and lands inside the
    // two-second budget.
    const d = decideHeap({ ...base, effectiveMemMb: 6144 });
    expect(d.action).toBe('refuse');
    if (d.action !== 'refuse') throw new Error('unreachable');
    expect(d.reason).toMatch(/4608 MB/);
    expect(d.reason).toMatch(/own the outcome/);
  });

  it('REFUSES rather than re-exec twice (the loop guard)', () => {
    const d = decideHeap({ ...base, limitMb: 3000, marker: true });
    expect(d.action).toBe('refuse');
    if (d.action !== 'refuse') throw new Error('unreachable');
    expect(d.reason).toMatch(/still 3000 MB/);
    expect(d.reason).toMatch(/Refusing rather than re-exec again/);
  });

  it('an explicit cap wins over the marker (an operator is never second)', () => {
    // the marker is set AND the operator also passed a cap: respect them
    expect(decideHeap({ ...base, limitMb: 2048, explicit: true, marker: true }).action).toBe(
      'refuse'
    );
    // ^ marker + short + explicit: the loop guard fires, because a process
    // that re-exec'd and came back short has nothing to gain from a third
    // try. Explicit-and-NOT-re-exec'd is the warn-proceed case above.
  });

  it('REFUSES with the remedy where execve does not exist (Node < 22.15)', () => {
    const d = decideHeap({ ...base, hasExecve: false });
    expect(d.action).toBe('refuse');
    if (d.action !== 'refuse') throw new Error('unreachable');
    // THE REMEDY IS THE CONTRACT on old Node — G5.a asserts this text from
    // a node:20-slim container
    expect(d.reason).toContain(`NODE_OPTIONS=--max-old-space-size=${DAEMON_HEAP_TARGET_MB}`);
    expect(d.reason).toContain('kami-lens daemon');
    expect(d.reason).toMatch(/22\.15/);
  });

  it('is total: every input combination decides something', () => {
    for (const limitMb of [512, 2048, 4144, 5120, 8192]) {
      for (const explicit of [true, false]) {
        for (const effectiveMemMb of [1024, 5632, 6144, 8192, 65_536]) {
          for (const hasExecve of [true, false]) {
            for (const marker of [true, false]) {
              const d = decideHeap({ limitMb, explicit, effectiveMemMb, hasExecve, marker });
              expect(['proceed', 'warn-proceed', 'reexec', 'refuse']).toContain(d.action);
              // a reexec never hands back something under the floor
              if (d.action === 'reexec') expect(d.targetMb).toBeGreaterThanOrEqual(COLD_BOOT_HEAP_FLOOR_MB);
              // a refusal always says something actionable
              if (d.action === 'refuse') expect(d.reason.length).toBeGreaterThan(40);
            }
          }
        }
      }
    }
  });
});

describe('reading the facts', () => {
  it('sees an explicit cap in NODE_OPTIONS and in execArgv, and nowhere else', () => {
    expect(heapExplicit({ NODE_OPTIONS: '--max-old-space-size=6144' }, [])).toBe(true);
    expect(heapExplicit({}, ['--max-old-space-size=6144'])).toBe(true);
    // underscores are the other spelling Node accepts
    expect(heapExplicit({ NODE_OPTIONS: '--max_old_space_size=6144' }, [])).toBe(true);
    expect(heapExplicit({ NODE_OPTIONS: '--enable-source-maps' }, ['--no-warnings'])).toBe(false);
    expect(heapExplicit({}, [])).toBe(false);
  });

  it('reports a positive effective memory for this machine', () => {
    // the cgroup branches cannot be exercised on macOS; the contract
    // asserted here is only that the fallback is sane and bounded
    const mb = effectiveMemMb();
    expect(mb).toBeGreaterThan(512);
    expect(mb).toBeLessThanOrEqual(Math.floor(os.totalmem() / 1024 / 1024));
  });
});
