// Gate G9.a [live, manual] — the pre-LIVE stall (0.5.2, DESIGN §3.2).
//
// WHAT IS BEING PROVEN. A daemon that starts while the network is down must
// not sit in SETUP forever once the network comes back. 0.5.1 did exactly
// that (observed live 2026-08-27, laptop-wake restart: SETUP / "Starting
// State Sync" / 0% / liveBlockNumber 0 for 8+ minutes while headBlockNumber
// advanced and no failure event ever fired). The cause is an ethers v6
// WebSocketProvider whose socket never opened: it never reconnects, and
// getBlockNumber() on it never settles — so ensureNetworkIsUp's Promise.all
// hangs, both callWithRetry ladders stall, and the bootstrap holds open with
// nothing to retry on. 0.5.2 bounds the probe (NETWORK_CHECK_TIMEOUT_MS) and
// adds a pre-LIVE progress watchdog (PRELIVE_STALL_MS) as the outer bound.
//
// THE SEVER METHOD IS AN ISOLATED DOCKER NETWORK NAMESPACE — `--network
// none` at start, `docker network connect bridge` to restore. NO host DNS
// and NO firewall change: a /etc/hosts blackhole or a packet filter rule
// would also cut the LIVE launchd kami-lens daemon on this Mac and the play
// session depending on it. The container cannot reach that service or its
// data directory, and `dist` is dockerignored so the host's built CLI is
// never written — fingerprinted before and after, and the gate fails if it
// moved (the G8 precedent).
//
// Control is the 0.5.1 tree at f07b578, built from a git worktree, so the
// two arms differ by the release and nothing else.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const SCRATCH = process.env.G9_SCRATCH ?? path.join(os.tmpdir(), 'kami-lens-g9');
const CONTROL_REF = process.env.G9_CONTROL_REF ?? 'f07b578';
/** how long the container runs with no network at all */
const OUTAGE_MS = 60_000;
/** how long we watch after the network is restored */
const CONTROL_WATCH_MS = Number(process.env.G9_CONTROL_WATCH_MS ?? 360_000);
const FIX_WATCH_MS = Number(process.env.G9_FIX_WATCH_MS ?? 360_000);
const POLL_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sh(cmd: string, args: string[], timeoutMs = 900_000): string {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
}
function shSoft(cmd: string, args: string[], timeoutMs = 60_000): { code: number; out: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
function fail(reason: unknown): never {
  console.error('FAIL G9.a', JSON.stringify(reason));
  process.exit(1);
}
/** the CLI prints one logger line before its JSON */
function parseJson(out: string): Record<string, unknown> | null {
  const start = out.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(out.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
function fingerprintDist(): string | null {
  const p = path.join(ROOT, 'dist', 'cli.js');
  if (!existsSync(p)) return null;
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

type Sample = {
  atMs: number;
  sinceStartS: number;
  state?: string;
  msg?: string;
  percentage?: number;
  liveBlockNumber?: number;
  bootstrapAttempts?: number;
  degraded?: string[];
  worldRead?: { code?: string; message?: string; ok?: boolean };
};

async function runArm(label: string, image: string, watchMs: number) {
  const container = `kami-lens-g9-${label}`;
  shSoft('docker', ['rm', '-f', container]);
  console.log(`[g9] ${label}: starting with NO network`);
  sh('docker', ['run', '-d', '--name', container, '--network', 'none', image, 'daemon']);
  const t0 = Date.now();
  const samples: Sample[] = [];
  let networkRestoredAtS: number | null = null;
  let liveAtS: number | null = null;
  let firstStallDegradedAtS: number | null = null;
  let notReadyText: string | null = null;
  let notReadySeen = false;

  const total = OUTAGE_MS + watchMs;
  try {
    while (Date.now() - t0 < total) {
      if (networkRestoredAtS === null && Date.now() - t0 >= OUTAGE_MS) {
        console.log(`[g9] ${label}: restoring network at ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        const c = shSoft('docker', ['network', 'connect', 'bridge', container]);
        if (c.code !== 0) fail({ step: 'network connect', label, out: c.out });
        networkRestoredAtS = (Date.now() - t0) / 1000;
      }
      const st = shSoft('docker', ['exec', container, 'kami-lens', 'status']);
      const parsed = st.code === 0 ? parseJson(st.out) : null;
      const data = (parsed?.data ?? {}) as Record<string, unknown>;
      const sample: Sample = {
        atMs: Date.now(),
        sinceStartS: Number(((Date.now() - t0) / 1000).toFixed(1)),
        state: data.state as string | undefined,
        msg: data.msg as string | undefined,
        percentage: data.percentage as number | undefined,
        liveBlockNumber: data.liveBlockNumber as number | undefined,
        bootstrapAttempts: data.bootstrapAttempts as number | undefined,
        degraded: data.degraded as string[] | undefined,
      };
      // one world read per poll, to capture the code a caller actually sees
      const rd = shSoft('docker', ['exec', container, 'kami-lens', 'node', '9']);
      const rp = parseJson(rd.out);
      if (rp) {
        const err = rp.error as { code?: string; message?: string } | undefined;
        sample.worldRead = { ok: rp.ok as boolean, code: err?.code, message: err?.message };
        if (err?.code === 'NOT_READY') {
          notReadySeen = true;
          if (!notReadyText) notReadyText = err.message ?? null;
        }
      }
      samples.push(sample);
      if (sample.degraded?.some((d) => d.startsWith('pre-live-stall:')) && firstStallDegradedAtS === null) {
        firstStallDegradedAtS = sample.sinceStartS;
      }
      if (sample.state === 'LIVE') {
        liveAtS = sample.sinceStartS;
        console.log(`[g9] ${label}: LIVE at ${liveAtS}s`);
        break;
      }
      await sleep(POLL_MS);
    }
  } finally {
    const logs = shSoft('docker', ['logs', '--tail', '400', container]);
    writeFileSync(path.join(SCRATCH, `g9-${label}.log`), logs.out);
    shSoft('docker', ['rm', '-f', container]);
  }

  const last = samples[samples.length - 1];
  return {
    image,
    reachedLive: liveAtS !== null,
    networkRestoredAtS,
    timeToLiveS: liveAtS,
    timeToLiveAfterRestoreS: liveAtS !== null && networkRestoredAtS !== null
      ? Number((liveAtS - networkRestoredAtS).toFixed(1))
      : null,
    recoveredWithoutKickstart: liveAtS !== null,
    bootstrapAttemptsAtEnd: last?.bootstrapAttempts ?? null,
    maxBootstrapAttempts: Math.max(0, ...samples.map((s) => s.bootstrapAttempts ?? 0)),
    preLiveStallDegradedFirstSeenAtS: firstStallDegradedAtS,
    degradedStringsSeen: [...new Set(samples.flatMap((s) => s.degraded ?? []))],
    notReadySeen,
    notReadyMessageObserved: notReadyText,
    worldReadCodesSeen: [...new Set(samples.map((s) => s.worldRead?.code).filter(Boolean))],
    finalState: last?.state ?? null,
    finalMsg: last?.msg ?? null,
    finalPercentage: last?.percentage ?? null,
    finalLiveBlockNumber: last?.liveBlockNumber ?? null,
    samples,
  };
}

// ---------------------------------------------------------------- main

const distBefore = fingerprintDist();
mkdirSync(SCRATCH, { recursive: true });

// control tree: the 0.5.1 release, from a worktree so nothing in the working
// checkout is touched
const controlTree = path.join(SCRATCH, 'control-tree');
if (existsSync(controlTree)) {
  shSoft('git', ['worktree', 'remove', '--force', controlTree]);
  rmSync(controlTree, { recursive: true, force: true });
}
console.log(`[g9] building control tree at ${CONTROL_REF}`);
sh('git', ['worktree', 'add', '--detach', controlTree, CONTROL_REF]);
const controlVersion = JSON.parse(readFileSync(path.join(controlTree, 'package.json'), 'utf8')).version;
const fixVersion = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

console.log('[g9] building images (this takes a few minutes)');
/** `npm ci` inside the image occasionally dies with npm's own
 * "Exit handler never called!" — an npm bug, not a repo one, and it leaves
 * node_modules half-installed so the next step fails with `tsup: not found`.
 * Retry once rather than throwing away a twenty-minute gate run. */
const buildMethod: Record<string, string> = {};
/** Reuse an image that already exists instead of rebuilding it. OPT-IN and
 * never a default, because a silently reused image is how an arm ends up
 * testing the wrong tree — which is exactly why the version assertion below
 * runs whether the image was built here or not. */
const REUSE_IMAGES = process.env.G9_REUSE_IMAGES === '1';
function buildImage(tag: string, context: string): void {
  if (REUSE_IMAGES && shSoft('docker', ['image', 'inspect', tag]).code === 0) {
    buildMethod[tag] = 'pre-existing image reused (G9_REUSE_IMAGES=1); version asserted below';
    console.log(`[g9] reusing ${tag}`);
    return;
  }
  try {
    sh('docker', ['build', '-t', tag, context], 1_800_000);
    buildMethod[tag] = 'repo Dockerfile (npm ci in-image)';
    return;
  } catch (e) {
    console.log(`[g9] ${tag} build failed, retrying once: ${(e as Error).message.slice(0, 160)}`);
  }
  try {
    sh('docker', ['build', '--no-cache', '-t', tag, context], 1_800_000);
    buildMethod[tag] = 'repo Dockerfile, --no-cache retry';
    return;
  } catch (e) {
    console.log(`[g9] ${tag} retry failed too, packing on the host: ${(e as Error).message.slice(0, 160)}`);
  }
  // FALLBACK. The in-image `npm ci` intermittently dies with npm's own
  // "Exit handler never called!" and exits ZERO with a half-installed
  // node_modules, so the build fails two steps later at `tsup: not found`.
  // G9 needs a daemon in an isolated network namespace; proving the
  // clean-room install path is G5.a/G5.b's job, so pack on the host and
  // install exactly that tarball into the same runtime base. Recorded.
  const nm = path.join(context, 'node_modules');
  if (!existsSync(nm)) {
    // the control worktree has no install of its own; the dependency set is
    // identical (only `version` differs between the two package.json files),
    // so borrow this checkout's
    sh('ln', ['-s', path.join(ROOT, 'node_modules'), nm]);
  }
  sh('npm', ['run', 'build'], 900_000);
  const packed = sh('npm', ['pack', '--pack-destination', context], 900_000).trim().split('\n').pop()!;
  sh('docker', [
    'build', '-f', path.join(ROOT, 'gates', 'g9', 'Dockerfile.prepacked'),
    '--build-arg', `TARBALL=${packed}`, '-t', tag, context,
  ], 1_800_000);
  buildMethod[tag] = 'host npm pack + gates/g9/Dockerfile.prepacked (in-image npm ci failed twice)';
}
buildImage('kami-lens:g9-control', controlTree);
buildImage('kami-lens:g9-fix', ROOT);

/** PROVE WHICH BUILD IS IN EACH IMAGE. Docker layer caching is what makes
 * this gate affordable to re-run, and it is also how an arm could quietly
 * end up testing the wrong tree — the same class of defect the Dockerfile's
 * own version assertion exists for. A two-arm comparison whose arms are not
 * the two releases is worse than no comparison. */
function imageVersion(tag: string): string {
  const out = shSoft('docker', ['run', '--rm', '--entrypoint', 'kami-lens', tag, '--version']);
  return (/kami-lens (\S+)/.exec(out.out)?.[1] ?? 'unknown').trim();
}
const controlImageVersion = imageVersion('kami-lens:g9-control');
const fixImageVersion = imageVersion('kami-lens:g9-fix');
if (controlImageVersion !== controlVersion || fixImageVersion !== fixVersion) {
  fail({
    reason: 'an image does not report the version of the tree it was built from',
    controlImageVersion,
    controlVersion,
    fixImageVersion,
    fixVersion,
  });
}
if (controlImageVersion === fixImageVersion) {
  fail({ reason: 'both arms report the same version — there is nothing to compare', controlImageVersion });
}
console.log(`[g9] control ${controlImageVersion} vs fix ${fixImageVersion}`);

const control = await runArm('control', 'kami-lens:g9-control', CONTROL_WATCH_MS);
const fix = await runArm('fix', 'kami-lens:g9-fix', FIX_WATCH_MS);

shSoft('git', ['worktree', 'remove', '--force', controlTree]);

const distAfter = fingerprintDist();
if (distBefore !== distAfter) {
  fail({ reason: "the host's dist/cli.js changed during the gate", distBefore, distAfter });
}

const record = {
  gate: 'g9a-prelive-stall',
  measuredAt: new Date().toISOString(),
  method:
    'isolated Docker network namespace: container started with `--network none`, ' +
    '`docker network connect bridge` after 60 s. No host DNS, hosts-file or firewall ' +
    'change — the LIVE launchd kami-lens daemon on this Mac and its play session are ' +
    'structurally out of reach. dist/cli.js fingerprinted before and after.',
  outageS: OUTAGE_MS / 1000,
  pollS: POLL_MS / 1000,
  controlRef: CONTROL_REF,
  controlVersion,
  fixVersion,
  controlImageVersion,
  fixImageVersion,
  buildMethod,
  hostDistSha256: distAfter,
  control,
  fix,
  verdict: {
    controlWedged: !control.reachedLive,
    fixRecovered: fix.reachedLive,
    fixRecoveredWithoutKickstart: fix.reachedLive,
  },
};

const stamp = new Date().toISOString().slice(0, 10);
const out = path.join(ROOT, 'docs', 'measurements', `g9-prelive-stall-${stamp}.json`);
writeFileSync(out, JSON.stringify(record, null, 2) + '\n');

if (!fix.reachedLive) {
  fail({ reason: '0.5.2 did not reach LIVE after the network returned', record: out });
}
console.log(
  'PASS G9.a',
  JSON.stringify({
    record: out,
    controlWedged: !control.reachedLive,
    controlFinalState: control.finalState,
    fixTimeToLiveS: fix.timeToLiveS,
    fixTimeToLiveAfterRestoreS: fix.timeToLiveAfterRestoreS,
    fixBootstrapAttempts: fix.maxBootstrapAttempts,
    notReady: fix.notReadySeen,
  })
);
