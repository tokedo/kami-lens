/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/workers/sync/state/store.ts
 * changes:  swap point 3 (DESIGN §4.1, §3.5) — the IndexedDB StateStore is
 *           replaced by a single-file binary snapshot with the same
 *           store-shaped API, so loaders.ts stays verbatim:
 *           - v8.serialize of {header, stores} (structured-clone semantics,
 *             Maps handled natively);
 *           - write temp file → fsync → atomic rename; one previous
 *             generation kept (.prev);
 *           - header {chainId, worldAddress, cacheVersion, kamigazeNonce,
 *             blockNumber}; chainId/worldAddress/cacheVersion mismatch →
 *             discard and re-bootstrap;
 *           - set() coalesces into one async flush, so upstream's
 *             `await Promise.all([...set()])` in loaders.toStore keeps its
 *             durability contract (all sets land in a single snapshot).
 *           StateStores/`getID` keep their upstream shapes; the two GetState
 *           cursors absent upstream (see loaders.ts note) are not persisted.
 *           The data directory comes from src/config.ts, overridable per
 *           store via the dataDir parameter — the same injection slot where
 *           upstream's get() accepts a custom idb?: IDBFactory.
 *           0.6.3: the commit sequence is EXTRACTED into commitSnapshotFile
 *           without changing a single step of it. The order is the crash
 *           safety (see that function), so it is now one named thing with
 *           the invariant written on it and an abort-point seam a test can
 *           drive — and the periodic checkpoint, which since 0.6.3 runs in
 *           a child process (workers/checkpoint/), reaches exactly this
 *           code, so the on-disk contract is the same code and not a second
 *           implementation of it.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';

import { getDataDir } from '../../../config';
import { ECSStateReply } from 'engine/types/ecs-snapshot';
import { log } from 'utils/logger';
import { StateEntry } from './types';

export type StateStore = Awaited<ReturnType<typeof get>>;
export type StateStores = {
  ComponentValues: StateEntry;
  BlockNumber: number;
  Mappings: string[];
  Snapshot: ECSStateReply;
  LastKamigazeBlock: number;
  LastKamigazeEntity: number;
  LastKamigazeComponent: number;
  KamigazeNonce: number;
};

type SnapshotHeader = {
  chainId: number;
  worldAddress: string;
  cacheVersion: number;
  kamigazeNonce: number;
  blockNumber: number;
};

type StoreMaps = Map<string, Map<string, unknown>>;

export class FileStateStore {
  private stores: StoreMaps = new Map();
  private flushPromise: Promise<void> | null = null;
  private flushQueued = false;

  constructor(
    readonly filePath: string,
    private header: Omit<SnapshotHeader, 'kamigazeNonce' | 'blockNumber'>
  ) {}

  async load(): Promise<void> {
    const raw = await readSnapshotFile(this.filePath);
    if (!raw) return;
    const { header, stores } = raw;
    if (
      header.chainId !== this.header.chainId ||
      header.worldAddress !== this.header.worldAddress ||
      header.cacheVersion !== this.header.cacheVersion
    ) {
      log.warn('[StateStore] snapshot header mismatch — discarding cache', {
        found: header,
        expected: this.header,
      });
      return;
    }
    this.stores = stores;
  }

  async get<Store extends keyof StateStores>(
    store: Store,
    key: string
  ): Promise<StateStores[Store] | undefined> {
    return this.stores.get(store)?.get(key) as StateStores[Store] | undefined;
  }

  async set<Store extends keyof StateStores>(
    store: Store,
    key: string,
    value: StateStores[Store]
  ): Promise<void> {
    let map = this.stores.get(store);
    if (!map) {
      map = new Map();
      this.stores.set(store, map);
    }
    map.set(key, value);
    return this.scheduleFlush();
  }

  /** Coalesce concurrent set()s into a single snapshot write. */
  private scheduleFlush(): Promise<void> {
    if (this.flushPromise) {
      this.flushQueued = true;
      return this.flushPromise.then(() => (this.flushQueued ? this.scheduleFlush() : undefined));
    }
    this.flushPromise = (async () => {
      // let same-tick set() calls land in this snapshot
      await new Promise((resolve) => setImmediate(resolve));
      this.flushQueued = false;
      await this.flush();
    })().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  /** Serialize {header, stores} → temp file → fsync → atomic rename. */
  async flush(): Promise<void> {
    const header: SnapshotHeader = {
      ...this.header,
      kamigazeNonce: (this.stores.get('KamigazeNonce')?.get('current') as number) ?? 0,
      blockNumber: (this.stores.get('BlockNumber')?.get('current') as number) ?? 0,
    };
    const buffer = v8.serialize({ header, stores: this.stores });
    await commitSnapshotFile(this.filePath, buffer);
    log.debug('[StateStore] snapshot flushed', {
      file: this.filePath,
      bytes: buffer.byteLength,
      blockNumber: header.blockNumber,
    });
  }
}

/** Where a commit is, for the abort-point test seam below. */
export type CommitStage = 'tmp-written' | 'rotated' | 'committed';

/**
 * Write one snapshot generation: temp file → fsync → rotate → atomic rename.
 *
 * THE ORDER IS THE CRASH SAFETY, and it is what makes a SIGTERM (or a
 * `kill` of the checkpoint child, 0.6.3) survivable at every instant:
 *
 *   before anything        primary valid (old), `.prev` valid (older)
 *   after the tmp write    unchanged — `.tmp` is not read by anyone
 *   after the rotation     primary MISSING, `.prev` valid (the old primary)
 *   after the rename       primary valid (new), `.prev` valid (the old one)
 *
 * So there is never an instant with neither a valid primary nor a valid
 * `.prev`, which is what readSnapshotFile's two-candidate walk relies on
 * (the L-8/L-10 class: a daemon killed mid-checkpoint). The guarantee comes
 * from the ORDER, not from anybody waiting politely — a waiter only avoids
 * losing the work, never the file.
 *
 * `onStage` exists so a test can abort at each of those instants against
 * this code rather than against a re-implementation of it. Production
 * callers pass nothing.
 */
export async function commitSnapshotFile(
  filePath: string,
  buffer: Buffer | Uint8Array,
  onStage?: (stage: CommitStage) => void | Promise<void>
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const handle = await fs.open(tmpPath, 'w');
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await onStage?.('tmp-written');
  // keep one previous generation
  try {
    await fs.rename(filePath, `${filePath}.prev`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await onStage?.('rotated');
  await fs.rename(tmpPath, filePath);
  await onStage?.('committed');
}

/** Read a snapshot file the way a boot does — primary first, then `.prev`.
 * Exported for the crash-safety test (0.6.3); the class uses it internally. */
export const readSnapshot = readSnapshotFile;

async function readSnapshotFile(
  filePath: string
): Promise<{ header: SnapshotHeader; stores: StoreMaps } | undefined> {
  for (const candidate of [filePath, `${filePath}.prev`]) {
    try {
      const buffer = await fs.readFile(candidate);
      const parsed = v8.deserialize(buffer) as { header: SnapshotHeader; stores: StoreMaps };
      if (!parsed?.header || !(parsed.stores instanceof Map)) throw new Error('malformed snapshot');
      if (candidate !== filePath) {
        log.warn('[StateStore] primary snapshot unreadable — recovered previous generation');
      }
      return parsed;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      log.warn(`[StateStore] failed to read snapshot ${candidate}`, e);
    }
  }
  return undefined;
}

// load in a StateStore from its computed ID
export const get = async (
  chainID: number,
  worldAddress: string,
  version: number,
  dataDir?: string
) => {
  const id = getID('ECSCache', chainID, worldAddress, version);
  const filePath = path.join(dataDir ?? getDataDir(), `${id}.v8snap`);
  const store = new FileStateStore(filePath, {
    chainId: chainID,
    worldAddress,
    cacheVersion: version,
  });
  await store.load();
  return store;
};

export const getBlockNumber = async (cache: StateStore): Promise<number> => {
  return (await cache.get('BlockNumber', 'current')) ?? 0;
};

// get the ID of a state cache based on its params
export const getID = (
  namespace: string,
  chainID: number,
  worldAddress: string,
  version: number
) => {
  return `${namespace}-${chainID}-${worldAddress}-v${version}`;
};
