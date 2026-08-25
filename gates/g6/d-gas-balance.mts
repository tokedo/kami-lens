// Gate G6.d [live] — the account gas balance, verified independently
// (§3.13, 0.5.0).
//
// The gas block is the ONE fact on the query surface read from the chain
// rather than from the mirror, so it gets the treatment every other
// chain-sourced row gets: an independent read of the same address at the
// same block must reproduce it exactly. Four properties, in order of what
// would hurt most if it broke:
//
//   · CORRECTNESS — the served wei for each address equals an independent
//     eth_getBalance at the block the answer itself names. Zero tolerance:
//     a balance is a discrete integer and there is nothing to drift.
//   · HONEST UNITS — `wei` is a decimal string (the value does not fit a
//     JSON number) and `eth` is that value divided by 1e18, not a second
//     opinion about it.
//   · HONEST CLOCKS — `gas.blockNumber` is the CHAIN block, and it is
//     allowed to run ahead of `meta.blockNumber`, which is the MIRROR's.
//     The gate asserts the two are reported separately and that the chain
//     block is not BEHIND the mirror's, because that ordering would mean
//     the balance was read against a state the mirror has already passed.
//   · NEVER BLOCKING — with the RPC unreachable the mirror answer is still
//     served, in full, minus the gas block; the failure is counted in
//     status.rpcReads rather than swallowed. Proved by pointing the reader
//     at a dead endpoint, not by mocking the failure.
//
// Needs: gates/.artifacts/c2.v8snap (mirror snapshot) and the public RPC.
// Read-only: eth_blockNumber and eth_getBalance, nothing else.

import path from 'node:path';

import { resolveConfig } from '../../src/config';
import { serveQuery } from '../../src/queries';
import { NativeBalanceReader } from '../../src/queries/build';
import { query as queryKamis } from '../../src/network/shapes/Kami/queries';
import { getKamiIndex } from '../../src/network/shapes/utils/component';
import {
  ARTIFACTS_DIR,
  fail,
  loadCacheFromSnapshotFile,
  makeProvider,
  pass,
  writeMeasurement,
} from '../g1/lib.mts';
import { buildMirror } from '../g2/lib.mts';

const config = resolveConfig();
const cache = await loadCacheFromSnapshotFile(path.join(ARTIFACTS_DIR, 'c2.v8snap'), config);
const { world, components } = buildMirror(cache);
const mirror = { world, components, blockNumber: cache.blockNumber };

const problems: Record<string, unknown>[] = [];
const counts: Record<string, number> = {};
const note = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);

const provider = makeProvider(config);
let rpcOk = 0;
let rpcFailed = 0;
const rpc: NativeBalanceReader = {
  blockNumber: async () => {
    rpcOk++;
    return provider.getBlockNumber();
  },
  nativeBalance: async (address, blockTag) => {
    rpcOk++;
    return provider.getBalance(address, blockTag);
  },
};
/** A reader pointed at nothing, for the never-blocking half. */
const deadRpc: NativeBalanceReader = {
  blockNumber: async () => {
    rpcFailed++;
    throw new Error('G6.d: deliberately unreachable endpoint');
  },
  nativeBalance: async () => {
    rpcFailed++;
    throw new Error('G6.d: deliberately unreachable endpoint');
  },
};

type AccountAnswer = {
  index: number;
  ownerAddress: string;
  operatorAddress: string;
  musu: number;
  gas?: {
    operator: { address: string; wei: string; eth: number };
    owner: { address: string; wei: string; eth: number };
    blockNumber: number;
  };
};

// --- sample accounts, the same walk every hermetic gate uses ---------------
const kamiIndexes = queryKamis(components)
  .slice(0, 400)
  .map((e) => getKamiIndex(components, e))
  .filter((i) => i > 0);
const accounts: number[] = [];
for (const index of kamiIndexes) {
  if (accounts.length >= 6) break;
  const kami = (
    await serveQuery(mirror, 'kami', [String(index)], { stale: false, mode: 'daemon' })
  ).data as { account?: { index: number } };
  const a = kami.account?.index;
  if (a && !accounts.includes(a)) accounts.push(a);
}
if (accounts.length === 0) fail('G6.d', { reason: 'no accounts reachable in the fixture' });

const samples: Record<string, unknown>[] = [];
for (const accountIndex of accounts) {
  const env = await serveQuery({ mirror, rpc }, 'account', [String(accountIndex)], {
    stale: false,
    mode: 'daemon',
  });
  const answer = env.data as AccountAnswer;
  note('accountsChecked');
  if (!answer.gas) {
    problems.push({ area: 'gas', reason: 'no gas block from a reachable RPC', accountIndex });
    continue;
  }
  const { gas } = answer;

  // --- clocks: reported separately, and the chain is not behind the mirror
  if (gas.blockNumber === undefined) {
    problems.push({ area: 'gas', reason: 'the gas block does not name the block it was read at', accountIndex });
  } else if (gas.blockNumber < env.meta.blockNumber) {
    problems.push({
      area: 'gas',
      reason: 'the balance was read at a block BEHIND the mirror — the two clocks are the wrong way round',
      accountIndex,
      chainBlock: gas.blockNumber,
      mirrorBlock: env.meta.blockNumber,
    });
  }

  // --- correctness: an independent read of the same address at the same block
  for (const [which, side] of [
    ['operator', gas.operator],
    ['owner', gas.owner],
  ] as const) {
    note('balancesVerified');
    const expectedAddress = which === 'operator' ? answer.operatorAddress : answer.ownerAddress;
    if (side.address.toLowerCase() !== expectedAddress.toLowerCase()) {
      problems.push({ area: 'gas', reason: 'the gas block names an address the account answer does not', accountIndex, which, served: side.address, expect: expectedAddress });
      continue;
    }
    const independent = await provider.getBalance(side.address, gas.blockNumber);
    if (independent.toString() !== side.wei) {
      problems.push({ area: 'gas', reason: 'served wei differs from an independent read at the same block', accountIndex, which, served: side.wei, independent: independent.toString(), block: gas.blockNumber });
    }
    // units: eth is the same number, not a second opinion
    if (!/^\d+$/.test(side.wei)) {
      problems.push({ area: 'gas', reason: 'wei is not a decimal integer string', accountIndex, which, served: side.wei });
    }
    if (Math.abs(side.eth - Number(BigInt(side.wei)) / 1e18) > 1e-12) {
      problems.push({ area: 'gas', reason: 'eth is not wei / 1e18', accountIndex, which, wei: side.wei, eth: side.eth });
    }
  }
  samples.push({
    accountIndex,
    chainBlock: gas.blockNumber,
    mirrorBlock: env.meta.blockNumber,
    blockSkew: gas.blockNumber - env.meta.blockNumber,
    operatorWei: gas.operator.wei,
    ownerWei: gas.owner.wei,
  });
}

// --- never blocking: the mirror answer survives an RPC that does not answer
{
  const accountIndex = accounts[0];
  const withRpc = (
    await serveQuery({ mirror, rpc }, 'account', [String(accountIndex)], { stale: false, mode: 'daemon' })
  ).data as AccountAnswer;
  const withDead = (
    await serveQuery({ mirror, rpc: deadRpc }, 'account', [String(accountIndex)], { stale: false, mode: 'daemon' })
  ).data as AccountAnswer;
  const withNone = (
    await serveQuery(mirror, 'account', [String(accountIndex)], { stale: false, mode: 'daemon' })
  ).data as AccountAnswer;
  note('degradationChecked');
  if (withDead.gas !== undefined) {
    problems.push({ area: 'gas/degraded', reason: 'a failed RPC read produced a gas block anyway' });
  }
  if (withNone.gas !== undefined) {
    problems.push({ area: 'gas/degraded', reason: 'a caller with no RPC at all got a gas block' });
  }
  // and everything else about the answer is untouched — the mirror half is
  // never coupled to the chain half
  const strip = (a: AccountAnswer) => JSON.stringify({ ...a, gas: undefined });
  if (strip(withDead) !== strip(withNone) || strip(withDead) !== strip(withRpc)) {
    problems.push({ area: 'gas/degraded', reason: 'the mirror half of the answer changed with the RPC state' });
  }
  if (rpcFailed === 0) {
    problems.push({ area: 'gas/degraded', reason: 'the failure path was never actually exercised' });
  }
}

await writeMeasurement('g6d-gas-balance', {
  snapshotBlock: cache.blockNumber,
  rpcUrl: config.jsonRpcUrl,
  accounts,
  samples,
  rpcCalls: { ok: rpcOk, deliberateFailures: rpcFailed },
  counts,
  problems,
});

if (problems.length > 0) {
  fail('G6.d', { reason: 'gas balance violations', problems: problems.slice(0, 10), problemCount: problems.length });
}
pass('G6.d', { ...counts, rpcCalls: rpcOk, samples: samples.length });
process.exit(0);
