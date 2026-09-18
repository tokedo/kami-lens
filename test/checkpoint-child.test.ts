// Divergence 16 (0.6.3): the periodic checkpoint runs off the main thread.
// DESIGN §3.5.
//
// Four things are asserted here, and they are the four the brief's item 4
// names:
//
//   (a) THE ON-DISK CONTRACT IS UNCHANGED. Same file name, same header,
//       `.tmp` gone, exactly one `.prev`. test/state-store.test.ts asserts
//       the store's own half of that and passes UNCHANGED; this asserts the
//       job that now drives it from another process reaches the same result.
//   (c) A KILL AT ANY POINT LEAVES A VALID PRIMARY OR A VALID `.prev`,
//       never neither — driven against the real commit code through its
//       abort-point seam, at every stage, rather than against a
//       re-implementation of the sequence. Plus the shutdown schedule.
//   (e) THE CHILD ENTRY RESOLVES AND RUNS. A forked child boots, resolves
//       the port's tsconfig-aliased import graph, and answers on the IPC
//       channel — which is the mechanism a worker thread could not provide
//       here (host.ts's banner has the measurement) and the one thing a
//       packaging defect would break silently.
//   (f) status carries `checkpoint.inFlight`: daemon-side, so only the
//       host's own view of it is asserted here.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { describe, expect, it } from 'vitest';

import { VERSION as CACHE_VERSION } from 'cache/db';
import {
  commitSnapshotFile,
  getID,
  readSnapshot,
  type CommitStage,
} from 'workers/sync/state/store';
import {
  createStateCache,
  getStateStore,
  saveStateCacheToStore,
  storeStateEvent,
  type StateCache,
} from 'workers/sync/state';
import { NetworkEvents } from 'workers/types';
import type { EntityID } from 'engine/recs';
import { runCheckpointJob, validateJob } from 'workers/checkpoint/job';
import { CheckpointHost, resolveChildEntry } from 'workers/checkpoint/host';
import {
  COMMIT_GRACE_MS,
  SHUTDOWN_GRACE_MS,
  shutdownDecision,
  type CheckpointJob,
} from 'workers/checkpoint/protocol';

const CHAIN = 1337;
const WORLD = '0xabc';
const COMPONENT = '0x4350dba81aa91e31664a09d24a668f006169a11b3d962b7557aed362d3252aec';

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'kami-lens-checkpoint-'));

function seedCache(blockNumber = 101): StateCache {
  const cache = createStateCache();
  storeStateEvent(cache, {
    type: NetworkEvents.NetworkComponentUpdate,
    component: COMPONENT,
    entity: '0x060d' as EntityID,
    value: { value: '0xbeef' },
    blockNumber,
  });
  cache.lastKamigazeBlock = blockNumber - 11;
  cache.kamigazeNonce = 7;
  return cache;
}

const job = (dataDir: string): CheckpointJob => ({
  chainId: CHAIN,
  worldAddress: WORLD,
  cacheVersion: CACHE_VERSION,
  dataDir,
  kamigazeUrl: 'https://kamigaze.invalid',
  snapshotNumChunks: 10,
});

const snapPath = (dataDir: string) =>
  path.join(dataDir, `${getID('ECSCache', CHAIN, WORLD, CACHE_VERSION)}.v8snap`);

describe('the checkpoint job (divergence 16, item 4a)', () => {
  it('loads the stored cache, applies the delta, and rewrites the same file', async () => {
    const dir = await tmpDir();
    const store = await getStateStore(CHAIN, WORLD, CACHE_VERSION, dir);
    await saveStateCacheToStore(store, seedCache());
    const before = await fs.readFile(snapPath(dir));

    // the delta, stubbed: advance the cache the way fetchSnapshot would
    const report = await runCheckpointJob(job(dir), {
      refresh: async (cache) => {
        cache.blockNumber = 200;
        cache.lastKamigazeBlock = 195;
        return cache;
      },
    });

    expect(report.blockNumber).toBe(200);
    expect(report.kamigazeNonce).toBe(7);
    expect(report.stateEntries).toBe(1);
    expect(report.tripwires).toBeTypeOf('object');

    const files = (await fs.readdir(dir)).sort();
    // the same primary, one previous generation, no temp file left behind
    expect(files).toContain(path.basename(snapPath(dir)));
    expect(files).toContain(`${path.basename(snapPath(dir))}.prev`);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);

    const primary = v8.deserialize(await fs.readFile(snapPath(dir))) as {
      header: Record<string, unknown>;
    };
    expect(primary.header).toMatchObject({
      chainId: CHAIN,
      worldAddress: WORLD,
      cacheVersion: CACHE_VERSION,
      kamigazeNonce: 7,
      blockNumber: 200,
    });
    // the rotated generation is byte-identical to what was there before
    expect(await fs.readFile(`${snapPath(dir)}.prev`)).toEqual(before);
  });

  it('refuses a job with no Kamigaze URL, with the daemon\'s own wording', () => {
    expect(() => validateJob({ ...job('/tmp/x'), kamigazeUrl: '' })).toThrow(
      /no-snapshot mode is bootstrap-only/
    );
    expect(() => validateJob(null)).toThrow(/job missing/);
    expect(() => validateJob({ ...job('/tmp/x'), dataDir: '' })).toThrow(/dataDir required/);
  });
});

describe('a kill mid-commit leaves a readable snapshot (item 4c, L-8/L-10)', () => {
  // Every instant of the commit sequence, driven against the real code.
  const stages: CommitStage[] = ['tmp-written', 'rotated', 'committed'];
  for (const stage of stages) {
    it(`recovers after an abort at '${stage}'`, async () => {
      const dir = await tmpDir();
      const file = path.join(dir, 'x.v8snap');
      const header = { chainId: CHAIN, worldAddress: WORLD, cacheVersion: CACHE_VERSION };
      const gen = (n: number) =>
        v8.serialize({
          header: { ...header, kamigazeNonce: 7, blockNumber: n },
          stores: new Map([['BlockNumber', new Map([['current', n]])]]),
        });

      // generation 1 commits cleanly, so there IS something to lose
      await commitSnapshotFile(file, gen(100));
      // generation 2 is aborted at `stage`, the way a SIGKILL would
      await expect(
        commitSnapshotFile(file, gen(200), (s) => {
          if (s === stage) throw new Error('killed');
        })
      ).rejects.toThrow('killed');

      const recovered = await readSnapshot(file);
      expect(recovered, `no readable generation left after '${stage}'`).toBeTruthy();
      // 'committed' means the rename landed before the abort, so 200 is
      // correct there; earlier aborts must still serve generation 1
      expect(recovered!.header.blockNumber).toBe(stage === 'committed' ? 200 : 100);
    });
  }

  it('the shutdown schedule waits, then kills — and waits longer once saving', () => {
    expect(shutdownDecision({ elapsedMs: 0, committing: false })).toBe('wait');
    expect(shutdownDecision({ elapsedMs: SHUTDOWN_GRACE_MS - 1, committing: false })).toBe('wait');
    // grace spent and nothing written yet: kill, nothing on disk was touched
    expect(shutdownDecision({ elapsedMs: SHUTDOWN_GRACE_MS, committing: false })).toBe('kill');
    // grace spent but the save is under way: one more window
    expect(shutdownDecision({ elapsedMs: SHUTDOWN_GRACE_MS, committing: true })).toBe('wait');
    expect(
      shutdownDecision({ elapsedMs: SHUTDOWN_GRACE_MS + COMMIT_GRACE_MS, committing: true })
    ).toBe('kill');
  });

  it('an idle host drains to idle', async () => {
    expect(await new CheckpointHost().drain()).toBe('idle');
  });
});

describe('the checkpoint child process (item 4e)', () => {
  it('resolves to an entry that exists, in whichever layout is running', () => {
    const { entry, useTsx } = resolveChildEntry();
    expect(entry).toMatch(/checkpoint-child\.(ts|js)$/);
    // under vitest this module is the .ts, so the src branch must be taken
    expect(useTsx).toBe(true);
  });

  it('boots, resolves the aliased import graph, and answers on the IPC channel', async () => {
    const host = new CheckpointHost();
    expect(host.inFlight).toBe(false);
    // a job the child must REFUSE: reaching the refusal proves the entry
    // loaded its whole import graph (validateJob lives behind
    // cache/db, utils/logger and the sync barrel) and that the protocol
    // round-trips. A worker thread could not get this far under tsx.
    const run = host.run({ ...job('/tmp/kami-lens-nonexistent'), kamigazeUrl: '' });
    await expect(run).rejects.toThrow(/no-snapshot mode is bootstrap-only/);
    expect(host.inFlight).toBe(false);
  }, 60_000);
});
