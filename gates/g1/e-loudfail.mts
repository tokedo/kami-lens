// Gate G1.e — loud-fail cold start (hermetic-ish: touches only the public
// RPC, never Kamigaze). Configured with no Kamigaze URL against the public
// RPC and an empty cache, the daemon must refuse with the documented
// ERR_NO_SNAPSHOT_SOURCE marker — not reach LIVE over a hollow world
// (DESIGN §3.1).

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ERR_NO_SNAPSHOT_SOURCE, KamiLensDaemon } from '../../src/daemon';
import { fail, pass } from './lib.mts';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kami-lens-g1e-'));

const daemon = new KamiLensDaemon({ kamigazeUrl: undefined, dataDir });

let sawLive = false;
daemon.status$.subscribe((s) => {
  if (s.state === 'LIVE') sawLive = true;
});

try {
  await daemon.start();
  fail('G1.e', { reason: 'daemon.start() did not throw without a snapshot source' });
} catch (e) {
  const error = e as Error & { code?: string };
  if (error.code !== ERR_NO_SNAPSHOT_SOURCE) {
    fail('G1.e', { reason: 'wrong error marker', code: error.code, message: error.message });
  }
  if (sawLive) fail('G1.e', { reason: 'daemon reached LIVE despite refusal' });
  pass('G1.e', {
    marker: error.code,
    message: error.message.slice(0, 160) + '…',
    dataDir,
  });
} finally {
  await daemon.stop().catch(() => {});
  await fs.rm(dataDir, { recursive: true, force: true });
}
process.exit(0);
