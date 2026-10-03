// A4 — durable checkpoints with more than one writer, and after a bad load.
//
// Two facts about commitSnapshotFile (workers/sync/state/store.ts):
//
//   1. EVERY WRITER USES THE SAME TEMP NAME, `<file>.tmp`. Two writers on one
//      store (two sync workers after a pre-LIVE restart that never cancelled
//      the first; a worker beside the checkpoint child) interleave on it: the
//      second one's rename consumes the first one's temp file, and the first
//      one's rename then fails with ENOENT — the Mac log line of 2026-10-01,
//      two "full load served by gRPC" lines followed by
//      `ENOENT rename …v8snap.tmp`.
//   2. THE ROTATION DOES NOT ASK WHETHER THE PRIMARY IS GOOD. A boot that
//      found the primary unreadable recovers `.prev` — and the next commit
//      renames that unreadable primary OVER the `.prev` it just recovered
//      from. Killed between the rotation and the final rename (exactly the
//      instant the commit order claims is safe), the store holds neither.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitSnapshotFile, FileStateStore, readSnapshot } from 'workers/sync/state/store';

let dir = '';
const file = () => path.join(dir, 'ECSCache-test.v8snap');
const header = { chainId: 1337, worldAddress: '0xabc', cacheVersion: 5 };
const snap = (blockNumber: number) =>
  v8.serialize({
    header: { ...header, kamigazeNonce: 1, blockNumber },
    stores: new Map([['BlockNumber', new Map([['current', blockNumber]])]]),
  });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kami-lens-writers-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('A4: two writers on one store', () => {
  it('interleaved commits both succeed and leave a whole snapshot', async () => {
    let resumeA!: () => void;
    const aPaused = new Promise<void>((r) => (resumeA = r));
    let aWrote!: () => void;
    const aAtTmp = new Promise<void>((r) => (aWrote = r));

    // writer A writes its temp file and is descheduled right there
    const a = commitSnapshotFile(file(), snap(100), async (stage) => {
      if (stage === 'tmp-written') {
        aWrote();
        await aPaused;
      }
    });
    await aAtTmp;
    // writer B runs a whole commit in that window
    await commitSnapshotFile(file(), snap(200));
    resumeA();

    const outcome = await a.then(
      () => 'ok',
      (e: NodeJS.ErrnoException) => `${e.code} ${e.syscall}`
    );
    expect.soft(outcome).toBe('ok');
    const read = await readSnapshot(file());
    expect.soft(read?.header.blockNumber === 100 || read?.header.blockNumber === 200).toBe(true);
  });
});

describe('A4: a primary that failed to load is never rotated over `.prev`', () => {
  it('the first commit after a recovered boot keeps the recovered generation as `.prev`', async () => {
    // a good generation in `.prev`, an unreadable primary (a torn write)
    await fs.writeFile(`${file()}.prev`, snap(100));
    await fs.writeFile(file(), Buffer.from('garbage'));

    const store = new FileStateStore(file(), header);
    await store.load(); // recovers `.prev`
    expect(await store.get('BlockNumber', 'current')).toBe(100);

    // the next save commits normally
    await store.set('BlockNumber', 'current', 300);
    expect((await readSnapshot(file()))?.header.blockNumber).toBe(300);

    // ...and `.prev` must still be a generation a boot can read. Rotating the
    // unreadable primary over it means a kill between that rotation and the
    // final rename would have left NEITHER file readable.
    const prev = await fs.readFile(`${file()}.prev`);
    let prevBlock: number | string;
    try {
      prevBlock = (v8.deserialize(prev) as { header: { blockNumber: number } }).header.blockNumber;
    } catch {
      prevBlock = `unreadable (${prev.byteLength} bytes)`;
    }
    expect(prevBlock).toBe(100);
  });
});
