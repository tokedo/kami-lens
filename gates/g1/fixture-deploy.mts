// kami-lens native module (not a port): gate-fixture support ONLY.
//
// 1.2.0. The daemon never invents a harvest multiplier: a node or a harvest
// whose K the mirror lacks is refused (node) or flagged INCOMPLETE (kami,
// party). This module writes K = 1000 into a FROZEN gate fixture taken before
// the multiplier's deploy, and nothing under src/ may import it: eslint's
// no-restricted-imports (eslint.config.js, src/**) refuses any src import of
// gates/ or test/, and test/import-boundary.test.ts fails on one.

import { packTuple, unpackTuple } from '@mud-classic/utils';
import { keccak256, toUtf8Bytes } from 'ethers';

import { formatComponentID } from 'engine/utils';
import type { StateCache } from 'workers/sync/state';

export const HARVEST_MULTIPLIER_ID = '0x017545640be52d18b8419842ba4066eb26707a37978580d5a2c11caa5f5b1552';
export const NODE_INDEX_ID = formatComponentID(keccak256(toUtf8Bytes('component.index.node')));
const HM_ID = formatComponentID(HARVEST_MULTIPLIER_ID);

/**
 * 1.2.0: a fixture taken before the harvest multiplier's deploy (2026-11-09)
 * holds no HarvestMultiplier row; 1.2.0 refuses a node without its K (the
 * chain gives every node one) and credits a harvest through its node's K. So
 * a fixture with NO HarvestMultiplier row at all gets the deploy's own writes
 * applied: K = 1000 (x1.0) on every node entity — what the deploy wrote with
 * `setMultiplier` on all 64 nodes, and what every node carried when it was
 * read on 2026-11-20. No harvest copy is added (a pre-K harvest has none and
 * pays its node's K), so at K = 1000 every credited amount equals 1.1.1's.
 * A fixture that holds any HarvestMultiplier row is left as it is.
 */
export function withHarvestMultiplierDeploy(cache: StateCache): StateCache {
  if (cache.componentToIndex.has(HM_ID) || cache.componentToIndex.has(HARVEST_MULTIPLIER_ID)) return cache;
  const nodeIdx = cache.componentToIndex.get(NODE_INDEX_ID);
  if (nodeIdx === undefined) return cache;
  const hmIdx = cache.components.push(HM_ID) - 1;
  cache.componentToIndex.set(HM_ID, hmIdx);
  let nodes = 0;
  for (const key of [...cache.state.keys()]) {
    const [c, e] = unpackTuple(key);
    if (c !== nodeIdx) continue;
    cache.state.set(packTuple([hmIdx, e]), { value: '0x3e8' } as never);
    nodes++;
  }
  console.log(`[fixture] no HarvestMultiplier rows (taken before its deploy): K = 1000 applied to ${nodes} node(s)`);
  return cache;
}
