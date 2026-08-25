// Gate G5.b [live] — container lifecycle. Build the image; assert the image
// installed the version this source tree declares; run with a mounted data
// volume; reach LIVE (healthcheck healthy, bootstrapMode 'cold' on the fresh
// volume); restart the container; status must report an incremental (warm)
// bootstrap and beat the cold time-to-healthy; healthcheck goes healthy again.
//
// THE VERSION ASSERTION IS NOT DECORATION (0.5.0). Two stale release
// tarballs were tracked in git; `COPY . .` carried them into the build stage
// beside the freshly packed one, and `npm install -g /tmp/kami-lens-*.tgz`
// installed all three — so which version a VM actually ran came down to
// install ordering. Four byte-identical builds of one image produced 0.4.0,
// 0.2.0, 0.1.0 and 0.2.0, and nothing anywhere said so. The Dockerfile now
// fails the build on an ambiguous glob or a version mismatch; this asserts
// the same thing from OUTSIDE the image, because a build-time check that is
// itself part of the thing being tested is not independent evidence.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fail, pass, REPO_ROOT, sleep, writeMeasurement } from '../g1/lib.mts';

const IMAGE = 'kami-lens:g5';
const CONTAINER = 'kami-lens-g5b';
const VOLUME = 'kami-lens-g5b-data';
let versionCheck: Record<string, string> = {};
const run = (cmd: string, args: string[], timeoutMs = 120_000): string =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, cwd: REPO_ROOT });

try {
  run('docker', ['info'], 30_000);
} catch {
  fail('G5.b', { reason: 'docker unavailable — start colima (--memory 8) first' });
}

const health = (): string => {
  try {
    return run('docker', ['inspect', '--format', '{{.State.Health.Status}}', CONTAINER]).trim();
  } catch {
    return 'unknown';
  }
};

const waitHealthy = async (capS: number): Promise<number> => {
  const t0 = Date.now();
  for (;;) {
    const h = health();
    if (h === 'healthy') return Math.round((Date.now() - t0) / 1000);
    if ((Date.now() - t0) / 1000 > capS) return -1;
    await sleep(5000);
  }
};

const statusField = <T,>(field: string): T => {
  const out = run('docker', ['exec', CONTAINER, 'kami-lens', 'status'], 60_000);
  const resp = JSON.parse(out) as { ok: boolean; data: Record<string, T> };
  if (!resp.ok) throw new Error('status query failed');
  return resp.data[field];
};

const steps: Record<string, boolean> = {};
let coldSeconds = -1;
let warmSeconds = -1;
try {
  run('docker', ['rm', '-f', CONTAINER]);
} catch { /* none */ }
try {
  run('docker', ['volume', 'rm', VOLUME]);
} catch { /* none */ }

try {
  console.log('building image (npm ci + build + pack inside — several minutes)');
  run('docker', ['build', '-t', IMAGE, '.'], 900_000);
  steps.imageBuilt = true;

  // --- the installed artifact IS the declared one --------------------------
  {
    const declared = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
    ).version as string;
    const reported = run('docker', ['run', '--rm', '--entrypoint', 'kami-lens', IMAGE, '--version'])
      .trim();
    // `kami-lens <version> (upstream Asphodel-OS/kamigotchi @ <pin>)`
    const installed = reported.split(/\s+/)[1] ?? '';
    const installedPkg = run('docker', [
      'run', '--rm', '--entrypoint', 'node', IMAGE,
      '-p', "require('/usr/local/lib/node_modules/kami-lens/package.json').version",
    ]).trim();
    const tarballs = run('docker', [
      'run', '--rm', '--entrypoint', 'sh', IMAGE,
      '-c', 'ls /usr/local/lib/node_modules | grep -c "^kami-lens$" || true',
    ]).trim();
    versionCheck = { declared, reported, installed, installedPkg, installedPackages: tarballs };
    if (installed !== declared || installedPkg !== declared) {
      fail('G5.b', {
        reason: 'the image installed a different version than this tree declares',
        ...versionCheck,
      });
    }
    if (tarballs !== '1') {
      fail('G5.b', { reason: 'expected exactly one installed kami-lens package', ...versionCheck });
    }
    steps.versionMatches = true;
  }

  run('docker', ['volume', 'create', VOLUME]);
  run('docker', ['run', '-d', '--name', CONTAINER, '-v', `${VOLUME}:/data`, IMAGE]);
  steps.containerUp = true;

  coldSeconds = await waitHealthy(600);
  steps.coldHealthy = coldSeconds >= 0;
  if (!steps.coldHealthy) fail('G5.b', { reason: 'healthcheck never went healthy (cold)', coldSeconds });
  steps.coldMode = statusField<string>('bootstrapMode') === 'cold';

  run('docker', ['restart', CONTAINER], 120_000);
  warmSeconds = await waitHealthy(600);
  steps.warmHealthy = warmSeconds >= 0;
  if (!steps.warmHealthy) fail('G5.b', { reason: 'healthcheck never went healthy (warm)', warmSeconds });
  steps.warmMode = statusField<string>('bootstrapMode') === 'warm';
  steps.warmResumeBlock = statusField<number>('resumeFromBlock') > 0;
  steps.warmBeatsCold = warmSeconds < coldSeconds;
} finally {
  try {
    run('docker', ['rm', '-f', CONTAINER]);
  } catch { /* gone */ }
  try {
    run('docker', ['volume', 'rm', VOLUME]);
  } catch { /* gone */ }
}

await writeMeasurement('g5b-container', {
  image: IMAGE,
  versionCheck,
  coldSeconds,
  warmSeconds,
  steps,
  match: Object.values(steps).every(Boolean),
});
if (!Object.values(steps).every(Boolean)) fail('G5.b', { steps, coldSeconds, warmSeconds });
pass('G5.b', { coldSeconds, warmSeconds, ...steps });
process.exit(0);
