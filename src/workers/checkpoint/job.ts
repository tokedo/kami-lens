// kami-lens native module (not a port): the checkpoint job (0.6.3,
// divergence 16). DESIGN §3.5.
//
// This is the body that used to sit in daemon.ts checkpoint(), moved
// verbatim in substance: load the STORED cache, run the ported incremental
// snapshot fetch (GetStateBlock + deltas since the stored cursors; a nonce
// change forces the full reload exactly as at bootstrap), save, done. It
// never touches the LIVE mirror — the daemon's own recs world and the live
// stream are a different object entirely, and live events are never folded
// into the persisted cache (daemon.ts's checkpoint-model note) — which is
// the single property that makes running it in another process possible at
// all.
//
// It is a plain exported function, not a process entry point, for two
// reasons: the entry (src/checkpoint-child.ts) stays three lines of
// plumbing, and a test can drive the whole job with a stubbed snapshot
// fetch and assert the on-disk contract without spawning anything.

import { VERSION as CACHE_VERSION } from 'cache/db';
import { createDecode } from 'engine/encoders';
import { log } from 'utils/logger';
import { createSnapshotClient, fetchSnapshot } from '../sync/snapshot';
import {
  getStateStore,
  loadStateCacheFromStore,
  saveStateCacheToStore,
  type StateCache,
} from '../sync/state';
import { tripwireReport } from '../../tripwires';
import type { CheckpointDone, CheckpointJob } from './protocol';

/** The snapshot half of the job, injectable so the hermetic test can drive
 * the real load/save around a delta it controls. Production never passes
 * it. */
export type CheckpointDeps = {
  refresh: (cache: StateCache, job: CheckpointJob) => Promise<StateCache>;
};

const defaultDeps: CheckpointDeps = {
  refresh: async (cache, job) => {
    const client = createSnapshotClient(job.kamigazeUrl);
    return fetchSnapshot(
      cache,
      client,
      createDecode(),
      job.snapshotNumChunks,
      () => {},
      () => {}
    );
  },
};

export function validateJob(job: Partial<CheckpointJob> | null | undefined): CheckpointJob {
  if (!job) throw new Error('checkpoint job missing');
  const { chainId, worldAddress, cacheVersion, dataDir, kamigazeUrl, snapshotNumChunks } = job;
  if (typeof chainId !== 'number' || !Number.isFinite(chainId)) {
    throw new Error('checkpoint job: chainId must be a number');
  }
  if (!worldAddress) throw new Error('checkpoint job: worldAddress required');
  if (!dataDir) throw new Error('checkpoint job: dataDir required');
  // the same refusal daemon.checkpoint() has always made, now made in the
  // child too so the contract does not depend on which side checked
  if (!kamigazeUrl) {
    throw new Error(
      'checkpoint refresh requires a Kamigaze URL (no-snapshot mode is bootstrap-only)'
    );
  }
  return {
    chainId,
    worldAddress,
    cacheVersion: typeof cacheVersion === 'number' ? cacheVersion : CACHE_VERSION,
    dataDir,
    kamigazeUrl,
    snapshotNumChunks: typeof snapshotNumChunks === 'number' ? snapshotNumChunks : 10,
  };
}

export async function runCheckpointJob(
  job: CheckpointJob,
  deps: CheckpointDeps = defaultDeps,
  onCommitting?: () => void
): Promise<Omit<CheckpointDone, 'kind' | 'peakRssKb'>> {
  const store = await getStateStore(job.chainId, job.worldAddress, job.cacheVersion, job.dataDir);
  let cache = await loadStateCacheFromStore(store);
  log.debug('[checkpoint] stored cache loaded', {
    blockNumber: cache.blockNumber,
    lastKamigazeBlock: cache.lastKamigazeBlock,
    stateEntries: cache.state.size,
  });
  cache = await deps.refresh(cache, job);
  onCommitting?.();
  await saveStateCacheToStore(store, cache);
  return {
    blockNumber: cache.blockNumber,
    kamigazeNonce: cache.kamigazeNonce,
    stateEntries: cache.state.size,
    numComponents: cache.components.length,
    numEntities: cache.entities.length,
    tripwires: tripwireReport(),
  };
}
