// Gate G8.b [live, manual] — chain-authoritative gap recovery across REPEATED
// short severs, and the mirror cross-checked against the chain afterwards
// (0.6.0, DESIGN §3.17, ledger row L-1).
//
// WHY THIS GATE EXISTS, AND WHY IT IS NOT G8.a. G8.a measures ONE ten-minute
// outage: does the daemon come back, and does the healed mirror agree with a
// cold one. That is not the failure L-1 was. L-1 was the FREQUENT SHORT gap —
// the production server closes the subscription every ~30-40 s by design, and
// the 2026-08-26..09-06 daemon log holds 17,369 gap-fills, one per ~55 s. The
// loss happened in one of those, silently, and the only way anyone found it
// was a human noticing a kami that should not have been harvesting. So this
// gate severs three times for ~20 s each — shorter than the server's own
// close, long enough to guarantee a real gap — and then asks the question the
// 0.5.3 daemon could not answer about itself: does every harvest this mirror
// calls ACTIVE actually read ACTIVE on chain?
//
// THE SEVER METHOD IS G8.a's, AND THAT CHOICE IS THE SAFETY PROPERTY.
// `docker network disconnect` on a dedicated container + volume: no sudo, no
// host routing change, and structurally unable to reach the launchd kami-lens
// service on this Mac or its data directory. The image builds inside Docker
// and `dist` is dockerignored, so the host's live dist/cli.js — which IS what
// the launchd service executes — is never written; it is fingerprinted before
// and after and asserted equal.
//
// THE CROSS-CHECK PRIMITIVE IS G3.b's, NOT A NEW ONE: pinned `has`/`getRaw`
// eth_calls through a retry-on-fresh-provider reader, pooled eight wide
// because sequential-with-backoff ages the pin out of the RPC's shallow
// eth_call state window (~50-120 blocks, the G6.b lesson). Component
// addresses come from the world's own on-chain Components registry, resolved
// off the checked-in snapshot fixture WITHOUT a replay — registry addresses
// do not move, and the state this gate checks lives in the container, not in
// the fixture.
//
// THE CROSS-CHECK IS SAMPLED, AND THE RULE IS STATED RATHER THAN DISCOVERED.
// A first run of this gate asked for EVERY ACTIVE harvest the mirror serves
// and got 6,603 of them — 13,206 pinned eth_calls, which is two things this
// gate must not be: far more public-RPC traffic than any other gate here
// makes (G3.b does ~120 reads, G6.b 101), and slow enough that the pin ages
// out of the RPC's ~50-120 block eth_call state window before the reads
// finish, so the tail of the run would fail for a reason that has nothing to
// do with the mirror. The sample is therefore: EVERY ACTIVE harvest on the
// busiest node, plus a deterministic stride of FLEET_SAMPLE_ROWS across all
// the others. Node-complete is the shape that matters — the L-1 phantom set
// was six kamis that stopped in one transaction — and the stride keeps the
// rest of the world represented. Counts and coverage are recorded, so what
// was checked is never larger than what is claimed.
//
// 0.6.1: the stride's budget was previously what a 400-row TOTAL cap left
// over after the node-complete set, which on a real fleet is nothing at all.
// It is now budgeted independently, and a stride contributing zero rows fails
// the gate rather than being recorded as coverage.
//
// SKEW IS ARBITRATED, NOT ASSUMED AWAY. The container is live, so a harvest
// can legitimately stop between the mirror answer and the pinned chain read.
// Every apparent divergence is therefore RE-READ from the container
// afterwards: if the mirror has since corrected itself it was skew, and if it
// still says ACTIVE while the chain says otherwise it is a phantom — which is
// exactly the L-1 shape, and which persisted for three and a half hours.
//
// Run it directly; it takes ~10-15 minutes:
//   npx tsx --tsconfig tsconfig.json gates/g8/b-gap-heal.mts

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { AbiCoder, Contract } from 'ethers';

import { resolveConfig } from '../../src/config';
import { getCompAddr } from '../../src/network/shapes/utils/addresses';
import { getAllNodes } from '../../src/network/shapes/Node';
import {
  ARTIFACTS_DIR,
  fail,
  loadCacheFromSnapshotFile,
  makeProvider,
  pass,
  REPO_ROOT,
  sleep,
  writeMeasurement,
} from '../g1/lib.mts';
import { buildMirror } from '../g2/lib.mts';

const IMAGE = 'kami-lens:g8b';
const CONTAINER = 'kami-lens-g8b';
const VOLUME = 'kami-lens-g8b-data';

/** three short severs, deliberately shorter than the server's own ~35 s
 * close: this gate is about the FREQUENT gap, not the outage. */
const SEVER_MS = 20_000;
const SEVERS = 3;
/** eth_call state window on the public RPC (measured 2026-07-21) */
const STATE_WINDOW_BLOCKS = 100;
/** How many rows the FLEET stride contributes, on top of the node-complete
 * set — see the sampling note in the header.
 *
 * 0.6.1 fix. This was `CROSSCHECK_MAX_ROWS = 400`, a cap on the TOTAL, and
 * the budget left for the stride was `max(0, 400 - nodeComplete.length)`.
 * The busiest node carries far more than 400 ACTIVE harvests on its own
 * (1,718 of 6,613 on 2026-09-06), so the budget was 0, the stride degenerated
 * to `others.length + 1`, and the fleet contributed ZERO rows — the recorded
 * coverageFraction of 0.2598 was the one node and nothing else. The stride
 * that "keeps the rest of the world represented" represented none of it.
 *
 * The fleet now gets its own budget, independent of the node-complete set. */
const FLEET_SAMPLE_ROWS = 300;

const COMPONENT_ABI = [
  'function has(uint256 entity) view returns (bool)',
  'function getRaw(uint256 entity) view returns (bytes)',
];
const abi = AbiCoder.defaultAbiCoder();

const sh = (cmd: string, args: string[], timeoutMs = 900_000): string =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, cwd: REPO_ROOT });
const shQuiet = (cmd: string, args: string[]): string => {
  try {
    return sh(cmd, args, 120_000);
  } catch {
    return '';
  }
};

// --- refuse to touch anything the local service owns ------------------------
{
  const home = process.env.HOME ?? '';
  const serviceDir = path.join(home, 'Library', 'Application Support', 'kami-lens');
  for (const name of [CONTAINER, VOLUME]) {
    if (name.includes('Application Support') || name.includes(home)) {
      fail('G8.b', { reason: 'a container/volume name resolves into the local service directory', name });
    }
  }
  if (existsSync(path.join(serviceDir, 'kami-lens.sock'))) {
    console.log('[g8.b] local launchd service detected — this gate never opens its socket or its data dir');
  }
}
const distPath = path.join(REPO_ROOT, 'dist', 'cli.js');
const distFingerprint = (): string | null =>
  existsSync(distPath) ? createHash('sha256').update(readFileSync(distPath)).digest('hex') : null;
const distBefore = distFingerprint();

const cleanup = () => {
  shQuiet('docker', ['rm', '-f', CONTAINER]);
  shQuiet('docker', ['volume', 'rm', '-f', VOLUME]);
};

type SyncBlock = {
  reconnects: number;
  gapsHealed: number;
  gapsDeferred: number;
  reconcilePasses: number;
  reconciledThrough: number | null;
  lastReconcileAt: string | null;
  unhealedRanges: [number, number][];
  lastHealMs: number | null;
  reconcileIntervalMs: number;
};
type Status = {
  version: string;
  state: string;
  liveBlockNumber: number;
  degraded: string[];
  blockLag?: number;
  headBlockNumber?: number;
  sync?: SyncBlock;
};

function statusOf(container: string): Status | null {
  try {
    const out = execFileSync('docker', ['exec', container, 'kami-lens', 'status'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    const parsed = JSON.parse(out) as { data?: Status } & Status;
    return (parsed.data ?? parsed) as Status;
  } catch {
    return null;
  }
}

async function waitForLive(container: string, timeoutMs: number): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = statusOf(container);
    if (s && s.state === 'LIVE' && s.degraded.length === 0) return Date.now() - t0;
    await sleep(3_000);
  }
  return null;
}

type NodeAnswer = {
  index: number;
  harvests?: { id?: string; state: string; kami: { id?: string; index: number } }[];
};
/**
 * `--full` is REQUIRED here, and not for verbosity: the compact node answer
 * omits `harvest.id` and `kami.id` entirely (both are --full-only in
 * queries/build.ts) and caps the row list at 50. Without it this gate would
 * cross-check a truncated list of rows it cannot address on chain — the
 * first run of it did exactly that and died converting `undefined` to a
 * BigInt, which is the honest failure and better than a silent sample.
 */
function nodeOf(container: string, index: number): NodeAnswer | null {
  try {
    const out = execFileSync(
      'docker',
      ['exec', container, 'kami-lens', 'node', String(index), '--full'],
      { encoding: 'utf8', timeout: 60_000 }
    );
    const parsed = JSON.parse(out) as { data?: NodeAnswer };
    return (parsed.data ?? null) as NodeAnswer | null;
  } catch {
    return null;
  }
}

const timeline: Record<string, unknown>[] = [];
const mark = (event: string, extra: Record<string, unknown> = {}) => {
  timeline.push({ at: new Date().toISOString(), event, ...extra });
  console.log(`[g8.b] ${event} ${JSON.stringify(extra)}`);
};

let result: Record<string, unknown> = {};
let provider: ReturnType<typeof makeProvider> | null = null;

try {
  // --- host-side: component addresses + the node index list ----------------
  // NO replay: this fixture is used only for the world's own registries,
  // whose addresses and node indexes do not move. The state under test lives
  // in the container.
  const config = resolveConfig();
  mark('loading-registry-fixture');
  const tFix = Date.now();
  const cache = await loadCacheFromSnapshotFile(path.join(ARTIFACTS_DIR, 'c2.v8snap'), config);
  const { world, components } = buildMirror(cache);
  const nodeIndexes = getAllNodes(world, components)
    .map((n) => n.index)
    .filter((i) => i > 0)
    .sort((a, b) => a - b);
  const compAddrs = {
    state: getCompAddr(world, components, 'component.state'),
    source: getCompAddr(world, components, 'component.id.source'),
    holder: getCompAddr(world, components, 'component.id.holder'),
  };
  mark('registry-fixture-loaded', {
    ms: Date.now() - tFix,
    nodes: nodeIndexes.length,
    compAddrs,
  });

  cleanup();
  mark('build-image');
  const tBuild = Date.now();
  sh('docker', ['build', '-t', IMAGE, '.'], 1_800_000);
  const dockerBuildMs = Date.now() - tBuild;
  const distAfterBuild = distFingerprint();
  if (distAfterBuild !== distBefore) {
    fail('G8.b', {
      reason: 'the container build changed the HOST dist/cli.js — the live service runs that file; aborting',
      before: distBefore,
      after: distAfterBuild,
    });
  }
  mark('host-dist-unchanged', { sha256: distBefore, dockerBuildMs });

  sh('docker', ['volume', 'create', VOLUME]);
  // DEBUG, as G8.a: the gap-fill call sites in gapfill.ts still announce
  // themselves there. The 0.6.0 [heal] lines are INFO on purpose, so this
  // gate would see them either way — which is the point of that change.
  sh('docker', [
    'run', '-d', '--name', CONTAINER,
    '-e', 'KAMI_LENS_LOG_LEVEL=DEBUG',
    '-v', `${VOLUME}:/data`, IMAGE, 'daemon',
  ]);
  mark('subject-started');
  const coldBootMs = await waitForLive(CONTAINER, 900_000);
  if (coldBootMs === null) {
    fail('G8.b', {
      reason: 'subject never reached LIVE',
      logs: shQuiet('docker', ['logs', '--tail', '80', CONTAINER]),
    });
  }
  const atLive = statusOf(CONTAINER)!;
  mark('subject-live', {
    coldBootMs,
    version: atLive.version,
    block: atLive.liveBlockNumber,
    sync: atLive.sync,
  });
  if (!atLive.sync) {
    fail('G8.b', { reason: 'status carries no `sync` block — 0.6.0 did not reach the container' });
  }

  // --- three short severs ---------------------------------------------------
  const severs: Record<string, unknown>[] = [];
  for (let i = 1; i <= SEVERS; i++) {
    const logsBefore = shQuiet('docker', ['logs', CONTAINER]).length;
    const before = statusOf(CONTAINER)!;
    sh('docker', ['network', 'disconnect', 'bridge', CONTAINER]);
    mark(`sever-${i}-start`, { block: before.liveBlockNumber, severMs: SEVER_MS });
    await sleep(SEVER_MS);
    sh('docker', ['network', 'connect', 'bridge', CONTAINER]);
    const restoredAt = Date.now();

    let reconnectMs: number | null = null;
    let caughtUpMs: number | null = null;
    while (Date.now() - restoredAt < 180_000) {
      const s = statusOf(CONTAINER);
      if (s) {
        if (reconnectMs === null && s.state === 'LIVE' && s.degraded.length === 0) {
          reconnectMs = Date.now() - restoredAt;
        }
        if (reconnectMs !== null && s.liveBlockNumber > before.liveBlockNumber) {
          caughtUpMs = Date.now() - restoredAt;
          break;
        }
      }
      await sleep(2_000);
    }
    const after = statusOf(CONTAINER)!;
    const logs = shQuiet('docker', ['logs', CONTAINER]).slice(logsBefore);
    // the 0.6.0 [heal] line is the whole point of the observability change
    const heals = [...logs.matchAll(
      /\[heal\] (gap|reconcile) (\d+)\.\.(\d+) path=(\S+) logs=(\d+) ms=(\d+) rpcHead=(\d+) src=(\w+) chunks=(\d+)/g
    )].map((m) => ({
      reason: m[1], from: Number(m[2]), to: Number(m[3]), path: m[4],
      logs: Number(m[5]), ms: Number(m[6]), rpcHead: Number(m[7]), headSrc: m[8],
      chunks: Number(m[9]),
    }));
    const deferrals = [...logs.matchAll(/\[heal\] (\w+) (\d+)\.\.(\d+) DEFERRED \(([\w-]+)\)/g)].map(
      (m) => ({ reason: m[1], from: Number(m[2]), to: Number(m[3]), cause: m[4] })
    );
    const tornDown = (logs.match(/subscription torn down during heal/g) ?? []).length;
    const kamigazeUsed = (logs.match(/Got \d+ events from Kamigaze/g) ?? []).length;
    severs.push({
      sever: i,
      blockAtSever: before.liveBlockNumber,
      blockAfter: after.liveBlockNumber,
      reconnectMs,
      caughtUpMs,
      healPath: heals.length > 0 ? [...new Set(heals.map((h) => h.path))].join('+') : 'none-observed',
      heals,
      deferrals,
      tornDownDuringHeal: tornDown,
      kamigazeDiffsUsed: kamigazeUsed,
      degradedAfter: after.degraded,
      sync: after.sync,
    });
    mark(`sever-${i}-done`, {
      reconnectMs,
      caughtUpMs,
      heals: heals.length,
      deferrals: deferrals.length,
      gapsHealed: after.sync?.gapsHealed,
      gapsDeferred: after.sync?.gapsDeferred,
      unhealed: after.sync?.unhealedRanges.length,
    });
  }

  // --- the mirror's ACTIVE harvests, cross-checked on chain -----------------
  mark('reading-node-answers', { nodes: nodeIndexes.length });
  const tRead = Date.now();
  const blockBeforeReads = statusOf(CONTAINER)!.liveBlockNumber;
  type Row = { harvestId: string; kamiId: string; kamiIndex: number; nodeIndex: number };
  const rows: Row[] = [];
  let unaddressable = 0;
  for (const idx of nodeIndexes) {
    const answer = nodeOf(CONTAINER, idx);
    for (const h of answer?.harvests ?? []) {
      if (h.state !== 'ACTIVE' && h.state !== 'HARVESTING') continue;
      // a row without ids cannot be addressed on chain; counted, never
      // silently dropped (it would mean the --full shape moved)
      if (!h.id || !h.kami?.id) {
        unaddressable++;
        continue;
      }
      rows.push({ harvestId: h.id, kamiId: h.kami.id, kamiIndex: h.kami.index, nodeIndex: idx });
    }
  }
  if (unaddressable > 0) {
    fail('G8.b', {
      reason: 'served ACTIVE harvests carry no id under --full — the node answer shape moved',
      unaddressable,
    });
  }
  const readMs = Date.now() - tRead;
  const blockAfterReads = statusOf(CONTAINER)!.liveBlockNumber;
  mark('node-answers-read', {
    ms: readMs,
    activeHarvests: rows.length,
    blockBeforeReads,
    blockAfterReads,
  });

  // --- the sample (see the header note) ------------------------------------
  const byNode = new Map<number, Row[]>();
  for (const r of rows) {
    const list = byNode.get(r.nodeIndex) ?? [];
    list.push(r);
    byNode.set(r.nodeIndex, list);
  }
  let busiestNode = -1;
  for (const [idx, list] of byNode) {
    if (busiestNode < 0 || list.length > (byNode.get(busiestNode)?.length ?? 0)) busiestNode = idx;
  }
  const nodeComplete = (byNode.get(busiestNode) ?? []).slice();
  const others = rows.filter((r) => r.nodeIndex !== busiestNode);
  // the fleet stride is budgeted independently of the node-complete set, so a
  // busy node can never squeeze it to nothing (0.6.1 — see FLEET_SAMPLE_ROWS)
  const stride = Math.max(1, Math.ceil(others.length / FLEET_SAMPLE_ROWS));
  const strided = others.filter((_, i) => i % stride === 0).slice(0, FLEET_SAMPLE_ROWS);
  const sample = [...nodeComplete, ...strided];
  // a stride that contributes nothing is the 0.6.0 defect returning; there is
  // no honest run with a fleet to sample and no fleet rows sampled
  if (others.length > 0 && strided.length === 0) {
    fail('G8.b', {
      reason: 'fleet stride contributed zero rows — the sample is one node and the coverage claim would be false',
      otherRows: others.length,
      stride,
      fleetBudget: FLEET_SAMPLE_ROWS,
    });
  }
  mark('crosscheck-sample', {
    activeHarvestsServed: rows.length,
    busiestNode,
    nodeCompleteRows: nodeComplete.length,
    strideRows: strided.length,
    stride,
    sampled: sample.length,
  });

  provider = makeProvider(config);
  const head = await provider.getBlockNumber();
  // pin inside the eth_call state window AND at or behind the chain head; the
  // container is essentially at head, so this is a few blocks back from both
  const pinnedBlock = Math.min(blockAfterReads, head) - 4;
  if (head - pinnedBlock > STATE_WINDOW_BLOCKS) {
    fail('G8.b', {
      reason: 'the pin fell outside the RPC eth_call state window before the reads started',
      head,
      pinnedBlock,
    });
  }
  const contracts = {
    state: new Contract(compAddrs.state, COMPONENT_ABI, provider),
    source: new Contract(compAddrs.source, COMPONENT_ABI, provider),
    holder: new Contract(compAddrs.holder, COMPONENT_ABI, provider),
  };
  const readRaw = async (contract: Contract, entityId: string): Promise<string | null> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const via = attempt === 0 ? provider! : makeProvider(config);
      try {
        const c =
          attempt === 0 ? contract : new Contract(await contract.getAddress(), COMPONENT_ABI, via);
        const exists: boolean = await c.has(BigInt(entityId), { blockTag: pinnedBlock });
        if (!exists) return null;
        return (await c.getRaw(BigInt(entityId), { blockTag: pinnedBlock })) as string;
      } catch (e) {
        if (attempt === 3) throw e;
        await sleep(500 * (attempt + 1));
      } finally {
        if (via !== provider) via.destroy();
      }
    }
    return null;
  };

  mark('chain-crosscheck', { rows: sample.length, pinnedBlock, head });
  const tCheck = Date.now();
  let verified = 0;
  const apparent: Record<string, unknown>[] = [];
  {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < sample.length) {
        const r = sample[cursor++]!;
        const [stateRaw, holderRaw] = await Promise.all([
          readRaw(contracts.state, r.harvestId),
          readRaw(contracts.holder, r.harvestId),
        ]);
        const chainState = stateRaw === null ? null : (abi.decode(['string'], stateRaw)[0] as string);
        const holderOk =
          holderRaw !== null && BigInt(abi.decode(['uint256'], holderRaw)[0]) === BigInt(r.kamiId);
        if (chainState === 'ACTIVE' && holderOk) verified++;
        else apparent.push({ ...r, chainState, holderOk });
      }
    };
    // pooled twelve wide: every read must land inside the RPC's shallow
    // eth_call state window, and sequential-with-backoff ages the pin out
    // of it (the G6.b lesson)
    await Promise.all(Array.from({ length: 12 }, () => worker()));
  }
  const crosscheckMs = Date.now() - tCheck;

  // --- arbitrate: skew, or a real phantom? ---------------------------------
  const phantoms: Record<string, unknown>[] = [];
  const skew: Record<string, unknown>[] = [];
  for (const a of apparent) {
    const answer = nodeOf(CONTAINER, a.nodeIndex as number);
    const still = (answer?.harvests ?? []).some(
      (h) => h.id === a.harvestId && (h.state === 'ACTIVE' || h.state === 'HARVESTING')
    );
    (still ? phantoms : skew).push({ ...a, mirrorStillActive: still });
  }
  mark('crosscheck-done', {
    ms: crosscheckMs,
    verified,
    apparent: apparent.length,
    phantoms: phantoms.length,
    skew: skew.length,
  });

  const final = statusOf(CONTAINER)!;
  result = {
    method:
      'docker network disconnect/connect on a dedicated container + volume, three severs of ~20 s (the FREQUENT gap, not the outage), then every ACTIVE harvest the mirror serves cross-checked against pinned eth_call reads. No sudo, no host routing change, structurally unable to reach the launchd kami-lens service or its data dir.',
    version: atLive.version,
    hostDistSha256: { before: distBefore, afterBuild: distAfterBuild, unchanged: true },
    dockerBuildMs,
    coldBootMs,
    severMs: SEVER_MS,
    severs,
    crosscheck: {
      activeHarvestsServed: rows.length,
      crossCheckedRows: sample.length,
      sampling: `every ACTIVE harvest on the busiest node (node ${busiestNode}, ${nodeComplete.length} rows) plus every ${stride}th of the remaining ${others.length} across the other ${byNode.size - 1} nodes (${strided.length} rows, fleet budget ${FLEET_SAMPLE_ROWS}). Node-complete is the shape that matters: the L-1 phantom set was six kamis that stopped in one transaction on one node. Checking all ${rows.length} would be 2x that many pinned eth_calls, which both exceeds any other gate's RPC traffic here and outlasts the RPC's own eth_call state window.`,
      coverageFraction: Number((sample.length / Math.max(1, rows.length)).toFixed(4)),
      nodeCompleteRows: nodeComplete.length,
      fleetStrideRows: strided.length,
      fleetStride: stride,
      fleetRowsAvailable: others.length,
      fleetNodesRepresented: new Set(strided.map((r) => r.nodeIndex)).size,
      busiestNode,
      unaddressableRows: unaddressable,
      nodesRead: nodeIndexes.length,
      nodeReadMs: readMs,
      pinnedBlock,
      chainHead: head,
      pinDepth: head - pinnedBlock,
      stateWindowBlocks: STATE_WINDOW_BLOCKS,
      verified,
      apparentDivergences: apparent.length,
      phantoms: phantoms.length,
      skewCorrectedByMirror: skew.length,
      phantomRows: phantoms,
      skewRows: skew.slice(0, 10),
      arbitration:
        'the container is live, so a harvest can legitimately stop between the mirror answer and the pinned chain read. Every apparent divergence is re-read from the container afterwards: mirror since corrected = skew; mirror still ACTIVE while the chain says otherwise = a phantom, the L-1 shape, which persisted for 3.5 hours when it happened.',
    },
    syncFinal: final.sync,
    timeline,
  };

  if (phantoms.length > 0) {
    fail('G8.b', { reason: 'phantom ACTIVE harvests survive the chain cross-check', phantoms });
  }
} finally {
  provider?.destroy();
  cleanup();
}

const distAfter = distFingerprint();
if (distAfter !== distBefore) {
  fail('G8.b', { reason: 'host dist/cli.js changed during the gate', before: distBefore, after: distAfter });
}

const file = await writeMeasurement('g8b-gap-heal', { ...result, match: true });
pass('G8.b', {
  severs: SEVERS,
  activeHarvests: (result.crosscheck as Record<string, unknown>)?.activeHarvestsServed,
  phantoms: (result.crosscheck as Record<string, unknown>)?.phantoms,
  measurement: file,
});
process.exit(0);
