// Gate G3.b [live] — node occupancy cross-check. The discovery-query proof:
// the node query's answer (which harvests are ACTIVE on a node) only exists
// via the mirror, but every element is chain-checkable. For a busy node,
// EVERY harvest the mirror lists as ACTIVE is verified by direct pinned
// eth_call reads of that harvest's State / SourceID / HolderID chain at
// the mirror's own block; plus negative samples — kamis the mirror reports
// harvesting elsewhere must NOT verify on this node.
//
// Node choice: the node whose ACTIVE-harvest count is closest to 40 —
// busy enough to be a real occupancy answer, bounded enough to verify
// EVERY row (no silent caps; the choice and counts are in the measurement).
// Component addresses come from the mirror's on-chain Components registry
// rows (the same registry the chain itself serves); reads retry on fresh
// provider connections (the G1.b load-balancer lesson).

import { AbiCoder, Contract } from 'ethers';
import path from 'node:path';

import { resolveConfig } from '../../src/config';
import { serveQuery } from '../../src/queries';
import { getCompAddr } from '../../src/network/shapes/utils/addresses';
import { getAllNodes } from '../../src/network/shapes/Node';
import {
  ARTIFACTS_DIR,
  fail,
  loadCacheFromSnapshotFile,
  makeFetchWorldEvents,
  makeProvider,
  pass,
  replayOnto,
  sleep,
  writeMeasurement,
} from '../g1/lib.mts';
import { buildMirror } from '../g2/lib.mts';

const COMPONENT_ABI = [
  'function has(uint256 entity) view returns (bool)',
  'function getRaw(uint256 entity) view returns (bytes)',
];
const abi = AbiCoder.defaultAbiCoder();

// The public RPC serves eth_call state only ~50–120 blocks deep (measured
// 2026-07-21: ok at depth 50, reverted at 120 — recorded in the
// measurement), so the mirror is healed to a near-head block first and
// every verification read pins to that fresh block inside the window.
const config = resolveConfig();
const cache = await loadCacheFromSnapshotFile(path.join(ARTIFACTS_DIR, 'c2.v8snap'), config);
{
  const p = makeProvider(config);
  const target = (await p.getBlockNumber()) - 8;
  console.log(`[g3.b] healing mirror ${cache.blockNumber} → ${target} for in-window reads`);
  await replayOnto(cache, makeFetchWorldEvents(p, config), target);
  p.destroy();
}
const { world, components } = buildMirror(cache);
const mirror = { world, components, blockNumber: cache.blockNumber };
const pinnedBlock = cache.blockNumber;
const verifyStartedAt = Date.now();

// --- pick the node: ACTIVE-harvest count closest to 40 ----------------------
type NodeAnswer = {
  index: number;
  name: string;
  harvests: { id: string; state: string; kami: { id: string; index: number } }[];
};
const nodes = getAllNodes(world, components).filter((n) => n.index);
let chosen: NodeAnswer | null = null;
for (const n of nodes) {
  const answer = serveQuery(mirror, 'node', [String(n.index)], { stale: false, mode: 'daemon' })
    .data as NodeAnswer;
  if (
    answer.harvests.length > 0 &&
    (!chosen || Math.abs(answer.harvests.length - 40) < Math.abs(chosen.harvests.length - 40))
  ) {
    chosen = answer;
  }
}
if (!chosen) fail('G3.b', { reason: 'no node with active harvests in the mirror' });
const node = chosen!;
console.log(`[g3.b] node ${node.index} (${node.name}): ${node.harvests.length} ACTIVE harvests`);
const nodeId = world.entities[
  (await import('../../src/network/shapes/Node/queries')).queryByIndex(world, node.index)
];

// --- pinned on-chain readers -------------------------------------------------
const provider = makeProvider(config);
const contracts = {
  state: new Contract(getCompAddr(world, components, 'component.state'), COMPONENT_ABI, provider),
  source: new Contract(
    getCompAddr(world, components, 'component.id.source'),
    COMPONENT_ABI,
    provider
  ),
  // the harvest→kami link on-chain is HolderID (mirror-verified; the plan's
  // 'IdOwnsKami' phrasing was design-phase shorthand)
  holder: new Contract(
    getCompAddr(world, components, 'component.id.holder'),
    COMPONENT_ABI,
    provider
  ),
};

async function readRaw(contract: Contract, entityId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const via = attempt === 0 ? provider : makeProvider(config);
    try {
      const c = attempt === 0 ? contract : new Contract(await contract.getAddress(), COMPONENT_ABI, via);
      const exists: boolean = await c.has(BigInt(entityId), { blockTag: pinnedBlock });
      if (!exists) return null;
      return await c.getRaw(BigInt(entityId), { blockTag: pinnedBlock });
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(500 * (attempt + 1));
    } finally {
      if (via !== provider) via.destroy();
    }
  }
  return null;
}

const eqId = (a: string | bigint, b: string): boolean => BigInt(a) === BigInt(b);

// --- verify every listed harvest --------------------------------------------
let verified = 0;
const violations: Record<string, unknown>[] = [];
for (const h of node.harvests) {
  const stateRaw = await readRaw(contracts.state, h.id);
  const sourceRaw = await readRaw(contracts.source, h.id);
  const holderRaw = await readRaw(contracts.holder, h.id);
  const stateOk = stateRaw !== null && abi.decode(['string'], stateRaw)[0] === 'ACTIVE';
  const sourceOk = sourceRaw !== null && eqId(abi.decode(['uint256'], sourceRaw)[0], nodeId);
  const kamiOk = holderRaw !== null && eqId(abi.decode(['uint256'], holderRaw)[0], h.kami.id);
  if (stateOk && sourceOk && kamiOk) verified++;
  else violations.push({ harvest: h.id, kami: h.kami.index, stateOk, sourceOk, kamiOk });
}

// --- negative samples: harvests on OTHER nodes must not verify here ---------
const negatives: Record<string, unknown>[] = [];
let negativeChecked = 0;
for (const other of nodes) {
  if (negativeChecked >= 10) break;
  if (other.index === node.index) continue;
  const answer = serveQuery(mirror, 'node', [String(other.index)], { stale: false, mode: 'daemon' })
    .data as NodeAnswer;
  for (const h of answer.harvests.slice(0, 2)) {
    if (negativeChecked >= 10) break;
    negativeChecked++;
    const sourceRaw = await readRaw(contracts.source, h.id);
    const claimsThisNode = sourceRaw !== null && eqId(abi.decode(['uint256'], sourceRaw)[0], nodeId);
    if (claimsThisNode) {
      negatives.push({ harvest: h.id, reportedNode: other.index, wronglyOnChosenNode: true });
    }
  }
}
provider.destroy();

await writeMeasurement('g3b-node-occupancy', {
  pinnedBlock,
  verifyElapsedMs: Date.now() - verifyStartedAt,
  rpcStateDepthNote: 'eth_call state served only ~50-120 blocks deep (measured 2026-07-21: ok@50, reverted@120)',
  nodeIndex: node.index,
  nodeName: node.name,
  activeHarvests: node.harvests.length,
  verified,
  violations,
  negativeSamples: negativeChecked,
  negativeViolations: negatives,
  match: violations.length === 0 && negatives.length === 0 && verified > 0 && negativeChecked > 0,
});

if (violations.length > 0 || negatives.length > 0 || verified === 0) {
  fail('G3.b', { reason: 'occupancy mismatch', violations, negatives, verified });
}
pass('G3.b', {
  node: node.index,
  activeHarvests: node.harvests.length,
  verified,
  negativeSamples: negativeChecked,
});
process.exit(0);
