// Gate G5.a [live] — clean-room install. `npm pack` → install the tarball
// in a fresh node:20 container → `kami-lens daemon` with ZERO config
// reaches LIVE → a sample query returns schema-valid JSON. Every step
// exit-code-checked. The container has only the tarball — whatever the
// package forgot to ship fails here.

import { execFileSync } from 'node:child_process';
import path from 'node:path';

import Ajv from 'ajv/dist/2020';

import { loadSchema } from '../../src/queries/registry';
import { fail, pass, REPO_ROOT, sleep, writeMeasurement } from '../g1/lib.mts';

const CONTAINER = 'kami-lens-g5a';
const run = (cmd: string, args: string[], timeoutMs = 120_000): string =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, cwd: REPO_ROOT });

// docker present?
try {
  run('docker', ['info'], 30_000);
} catch {
  fail('G5.a', { reason: 'docker unavailable — start colima (--memory 8) first' });
}

// fresh tarball
const packOut = run('npm', ['pack', '--json'], 300_000);
const tarball = (JSON.parse(packOut) as { filename: string }[])[0].filename;
console.log(`packed ${tarball}`);

const steps: Record<string, boolean> = {};
try {
  run('docker', ['rm', '-f', CONTAINER]);
} catch {
  /* no leftover container */
}

let coldSeconds = -1;
try {
  // container with ONLY node:20 + the tarball (docker cp, not a bind
  // mount — colima's shared-folder mounts go stale across re-packs)
  run('docker', ['run', '-d', '--name', CONTAINER, 'node:20-slim', 'sleep', 'infinity']);
  steps.containerUp = true;
  run('docker', ['cp', path.join(REPO_ROOT, tarball), `${CONTAINER}:/pkg.tgz`]);

  run('docker', ['exec', CONTAINER, 'npm', 'install', '-g', '/pkg.tgz'], 300_000);
  steps.install = true;

  const version = run('docker', ['exec', CONTAINER, 'kami-lens', '--version']);
  steps.version = version.includes('kami-lens') && /[0-9a-f]{40}/.test(version);
  console.log(version.trim());

  // zero-config daemon (baked Yominet defaults), detached
  run('docker', ['exec', '-d', CONTAINER, 'kami-lens', 'daemon']);
  steps.daemonStarted = true;

  const t0 = Date.now();
  let live = false;
  for (let i = 0; i < 100; i++) {
    await sleep(5000);
    try {
      run('docker', ['exec', CONTAINER, 'kami-lens', 'health'], 20_000);
      live = true;
      break;
    } catch {
      /* not LIVE yet */
    }
  }
  coldSeconds = Math.round((Date.now() - t0) / 1000);
  steps.live = live;
  if (!live) fail('G5.a', { reason: 'daemon did not reach LIVE in the container within 500 s', steps });

  // sample query → schema-valid envelope with data
  const itemsOut = run('docker', ['exec', CONTAINER, 'kami-lens', 'items'], 60_000);
  const response = JSON.parse(itemsOut) as { ok: boolean; data: { items: unknown[] } };
  steps.queryOk = response.ok === true;
  const ajv = new Ajv({ strict: true, allErrors: true });
  steps.querySchemaValid = ajv.validate(loadSchema('items'), response.data) as boolean;
  steps.queryNonEmpty = response.data.items.length > 100;
} finally {
  try {
    run('docker', ['rm', '-f', CONTAINER]);
  } catch {
    /* already gone */
  }
}

await writeMeasurement('g5a-cleanroom', {
  tarball,
  steps,
  timeToLiveSeconds: coldSeconds,
  match: Object.values(steps).every(Boolean),
});
if (!Object.values(steps).every(Boolean)) fail('G5.a', { steps });
pass('G5.a', { tarball, timeToLiveSeconds: coldSeconds, ...steps });
process.exit(0);
