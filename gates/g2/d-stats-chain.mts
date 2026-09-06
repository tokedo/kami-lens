// Gate G2.d [live] — the kami sheet's stat block, verified against chain
// (0.5.1, DESIGN §3.16). The `--stats` flag projects `base`/`shift`/`boost`/
// `sync`/`total` for health, power, harmony and violence, plus the
// [body, hand] affinity pair. Every one of those is served out of the
// MIRROR; this gate asserts each against `GetterSystem.getKamiByIndex` — the
// chain's own view — at the mirror's own pinned block.
//
// WHY THAT GETTER AND NOT THE ORACLE. The hybrid-play workaround (2026-08-26)
// established that this call is the truth for a kami sheet; the oracle's
// `kami_static` is NOT, because its coverage collapses on recent indices —
// which is exactly the band a stats surface most needs to be right about. So
// the vector is the getter, sampled across three index bands (<15000,
// 19000-19999, 20000+), and the sampling is recorded rather than assumed.
//
// THE GETTER REVERTS FOR SOME KAMIS THE MIRROR SERVES, and this gate exists
// partly to say WHICH — because the first version of the claim was wrong and
// the gate is what caught it.
//
// Gate-1 observed 19999 answering, 20000/20001/20010/20100 reverting and
// 20002 answering, and generalised to "the getter reverts for every kami with
// no owning account". The probe then reached kamis 1, 6 and 71 — also
// account-less, and answered fine. The real correlate is the STATE: an
// account-less kami in state `721_EXTERNAL` has been bridged out of the world
// and the getter still resolves it, while an account-less kami still IN the
// world (unminted / gacha-pool / unrevealed, and at least one levelled
// straggler) reverts. So the probe below is spread across the index space,
// records each kami's state beside its result, and DERIVES its note from the
// grouping rather than asserting a sentence written in advance.
//
// Either way the consequence for sampling is the same: the vector is drawn
// from OWNED kamis only, because those are the ones the chain will answer for
// reliably. The probe is a report line, not a failure — the mirror is not
// wrong to serve a kami the getter declines to describe, and recording it is
// what stops the next reader mistaking it for a parity break.
//
// TWO TRAPS THIS GATE IS BUILT AROUND:
//   1. `stat.shift` on an ethers `Result` resolves to Array.prototype.shift —
//      the FUNCTION, not the field — and Number(fn) is NaN, which JSON turns
//      into `null`. A first pass of this vector produced `"shift": null` for
//      every kami and looked like data. Every tuple goes through
//      `.toObject()` here, and every part is asserted finite (§3.14).
//   2. the mirror's `shift` is BONUS-INCLUSIVE (getStats is called with
//      withBonus=true, folding STAT_*_SHIFT from skills and equipment in),
//      while the chain's stored component value is not. Both numbers are
//      recorded per kami. Today they agree everywhere measured; if any kami
//      is ever found where they do not, the served shape gains an explicit
//      `shiftBonus` and this gate asserts shift === chainShift + shiftBonus.
//      Until then a divergence is reported and NOT silently tolerated.
//
// Execution follows the G6.b pattern: the public RPC serves eth_call state
// only ~50-120 blocks deep (§4.1), so the mirror is healed to near head in
// two stages and the reads run through a small concurrency pool. Elapsed
// time and block distance go in the measurement.

import { AbiCoder, Contract, keccak256, Result, toUtf8Bytes } from 'ethers';
import path from 'node:path';

import { resolveConfig } from '../../src/config';
import { serveQuery } from '../../src/queries';
import { getKamiAccount } from '../../src/app/cache/kami';
import { query as queryKamis } from '../../src/network/shapes/Kami/queries';
import { getKamiIndex, getState } from '../../src/network/shapes/utils/component';
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

/** Minimum sampled kamis, and the minimum in each band. The brief's floor is
 * 20 overall; the per-band floor stops a pass that only ever looked at old
 * indices, which is the failure mode the oracle's coverage collapse is. */
const MIN_SAMPLES = 20;
const MIN_PER_BAND = 4;

const BANDS = [
  { name: 'lt15000', lo: 0, hi: 14_999 },
  { name: '19000_19999', lo: 19_000, hi: 19_999 },
  { name: 'gte20000', lo: 20_000, hi: Number.MAX_SAFE_INTEGER },
] as const;

/** Which snapshot to heal FROM. Defaults to the shared `c2.v8snap` fixture
 * every other gate uses, but that fixture ages: it was captured 2026-08-06,
 * and by late August healing it to head is an ~840 000-block RPC replay that
 * accumulates every event in one array before it returns — tens of minutes and
 * gigabytes, before a single chain read happens.
 *
 * `--snapshot <path>` takes a fresher base instead. THE BASE DOES NOT AFFECT
 * WHAT IS PROVED: the reference is the chain, and every served value is
 * compared against an `eth_call` at the mirror's own pinned block. A closer
 * base only means less replay between the snapshot and that pin — strictly
 * less drift, not less rigour. The base actually used is recorded in the
 * measurement, because a gate that does not say what it started from is not
 * reproducible. */
const snapshotArg = (() => {
  const i = process.argv.indexOf('--snapshot');
  return i >= 0 ? process.argv[i + 1]! : path.join(ARTIFACTS_DIR, 'c2.v8snap');
})();

const t0 = Date.now();
const config = resolveConfig();
const cache = await loadCacheFromSnapshotFile(snapshotArg, config);
const snapshotBlock = cache.blockNumber;
{
  // two-stage heal (G6.b's first-run lesson): the coarse replay takes
  // minutes, so a target computed before it is already outside the state
  // window by the time the first read lands. Pay the long gap, then re-pin.
  const p = makeProvider(config);
  const coarse = (await p.getBlockNumber()) - 6;
  console.log(`[g2.d] coarse heal ${cache.blockNumber} -> ${coarse}`);
  await replayOnto(cache, makeFetchWorldEvents(p, config), coarse, { provider: p });
  const target = (await p.getBlockNumber()) - 6;
  console.log(`[g2.d] delta re-pin ${cache.blockNumber} -> ${target}`);
  await replayOnto(cache, makeFetchWorldEvents(p, config), target, { provider: p });
  p.destroy();
}
const { world, components } = buildMirror(cache);
const mirror = { world, components, blockNumber: cache.blockNumber };
const pinnedBlock = cache.blockNumber;

async function serve(query: string, args: string[]): Promise<unknown> {
  return (await serveQuery(mirror, query, args, { stale: false, mode: 'daemon' })).data;
}

// --- the chain side: resolve GetterSystem exactly as src/stateless.ts does --
const WORLD_ABI = ['function systems() view returns (address)'];
const REGISTRY_ABI = ['function getEntitiesWithValue(bytes value) view returns (uint256[])'];
const GETTER_ABI = [
  'function getKamiByIndex(uint32 index) view returns (tuple(uint256 id, uint32 index, string name, string mediaURI, tuple(tuple(int32 base, int32 shift, int32 boost, int32 sync) health, tuple(int32 base, int32 shift, int32 boost, int32 sync) power, tuple(int32 base, int32 shift, int32 boost, int32 sync) harmony, tuple(int32 base, int32 shift, int32 boost, int32 sync) violence) stats, tuple(uint32 face, uint32 hand, uint32 body, uint32 background, uint32 color) traits, string[] affinities, uint256 account, uint256 level, uint256 xp, uint32 room, string state))',
];
const GETTER_SYSTEM_ID = keccak256(toUtf8Bytes('system.getter'));

const provider = makeProvider(config);
const worldContract = new Contract(config.worldAddress, WORLD_ABI, provider);
const systemsRegistry: string = await worldContract.systems({ blockTag: pinnedBlock });
const systemsContract = new Contract(systemsRegistry, REGISTRY_ABI, provider);
const encodedId = AbiCoder.defaultAbiCoder().encode(['uint256'], [GETTER_SYSTEM_ID]);
const getterEntities: bigint[] = await systemsContract.getEntitiesWithValue(encodedId, {
  blockTag: pinnedBlock,
});
if (getterEntities.length === 0) {
  fail('G2.d', { reason: 'GetterSystem not found in the systems registry', pinnedBlock });
}
const getterAddress = '0x' + getterEntities[0]!.toString(16).padStart(40, '0');
console.log(`[g2.d] systems=${systemsRegistry} getter=${getterAddress} block=${pinnedBlock}`);

type ChainStat = { base: number; shift: number; boost: number; sync: number };
type ChainKami = {
  stats: Record<'health' | 'power' | 'harmony' | 'violence', ChainStat>;
  affinities: string[];
};

/** Trap 1: go through toObject(), never property access, and refuse a
 * non-finite part rather than letting it become a JSON null. */
function chainStat(raw: unknown, where: string): ChainStat {
  const o = (raw instanceof Result ? raw.toObject() : raw) as Record<string, unknown>;
  const num = (k: string): number => {
    const v = Number(o[k] as bigint);
    if (!Number.isFinite(v)) {
      fail('G2.d', {
        reason: 'chain stat part is not finite — a Result field was read as a prototype method',
        where,
        part: k,
        raw: String(o[k]),
      });
    }
    return v;
  };
  return { base: num('base'), shift: num('shift'), boost: num('boost'), sync: num('sync') };
}

async function readChainKami(index: number): Promise<ChainKami | { revert: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const via = attempt === 0 ? provider : makeProvider(config);
    try {
      const getter = new Contract(getterAddress, GETTER_ABI, via);
      const s = await getter.getKamiByIndex(index, { blockTag: pinnedBlock });
      return {
        stats: {
          health: chainStat(s.stats.health, `kami ${index} health`),
          power: chainStat(s.stats.power, `kami ${index} power`),
          harmony: chainStat(s.stats.harmony, `kami ${index} harmony`),
          violence: chainStat(s.stats.violence, `kami ${index} violence`),
        },
        affinities: [...(s.affinities as string[])],
      };
    } catch (e) {
      if (attempt === 2) return { revert: String(e).slice(0, 120) };
      await sleep(300 * (attempt + 1));
    } finally {
      if (via !== provider) via.destroy();
    }
  }
  return { revert: 'unreachable' };
}

// --- sampling: OWNED kamis, spread across the three bands ------------------
const entities = queryKamis(components, {});
const byBand = new Map<string, number[]>(BANDS.map((b) => [b.name, []]));
const unowned: { index: number; state: string }[] = [];
for (const entity of entities) {
  const index = getKamiIndex(components, entity);
  if (!index) continue;
  // OWNED means exactly what the SERVED surface means by it: buildKamiVitals
  // emits an `account` block only when `getKamiAccount(...).index` is
  // truthy, so that is the predicate here too.
  //
  // The obvious-looking alternative is wrong, and its first run proved it:
  // `queryKamiAccount(...) !== undefined` resolves the owner ID through
  // `world.entityToIndex`, which succeeds for holders that are not player
  // accounts at all. It classified kamis 1, 6, 11, 20 and 37 as UNOWNED —
  // all of which the getter answers for perfectly well — so the unowned
  // probe reported zero reverts and would have shipped a recorded finding
  // that contradicted the evidence it was written from.
  const owned = getKamiAccount(world, components, entity).index > 0;
  if (!owned) {
    unowned.push({ index, state: getState(components, entity) });
    continue;
  }
  const band = BANDS.find((b) => index >= b.lo && index <= b.hi);
  if (!band) continue;
  const bucket = byBand.get(band.name)!;
  // spread the sample across the band rather than taking the first N in
  // iteration order, which would cluster
  bucket.push(index);
}
const sample: { index: number; band: string }[] = [];
for (const band of BANDS) {
  const all = byBand.get(band.name)!.sort((a, b) => a - b);
  const want = Math.max(MIN_PER_BAND, Math.ceil(MIN_SAMPLES / BANDS.length));
  if (all.length === 0) continue;
  const stride = Math.max(1, Math.floor(all.length / want));
  for (let i = 0, taken = 0; i < all.length && taken < want; i += stride, taken++) {
    sample.push({ index: all[i]!, band: band.name });
  }
}
const perBand = Object.fromEntries(
  BANDS.map((b) => [b.name, sample.filter((s) => s.band === b.name).length])
);
if (sample.length < MIN_SAMPLES) {
  fail('G2.d', { reason: 'sample below the floor', sampled: sample.length, MIN_SAMPLES, perBand });
}
for (const b of BANDS) {
  if ((perBand[b.name] ?? 0) < MIN_PER_BAND) {
    fail('G2.d', { reason: `band ${b.name} below its floor`, perBand, MIN_PER_BAND });
  }
}
console.log(`[g2.d] sampling ${sample.length} owned kamis ${JSON.stringify(perBand)}`);

// --- the comparison --------------------------------------------------------
type Served = {
  index: number;
  stats?: Record<string, { base: number; shift: number; boost: number; sync: number; total: number }>;
  affinities?: string[];
};
const problems: Record<string, unknown>[] = [];
const rows: Record<string, unknown>[] = [];
const shiftDivergences: Record<string, unknown>[] = [];
const STAT_NAMES = ['health', 'power', 'harmony', 'violence'] as const;

const POOL = 4;
let cursor = 0;
async function worker(): Promise<void> {
  for (;;) {
    const mine = cursor++;
    if (mine >= sample.length) return;
    const { index, band } = sample[mine]!;
    const served = (await serve('kami', [String(index), '--stats'])) as Served;
    const chain = await readChainKami(index);
    if ('revert' in chain) {
      problems.push({ index, band, reason: 'getter reverted for an OWNED kami', detail: chain.revert });
      continue;
    }
    if (!served.stats || !served.affinities) {
      problems.push({ index, band, reason: '--stats served no stat block' });
      continue;
    }
    const row: Record<string, unknown> = { index, band };
    for (const name of STAT_NAMES) {
      const s = served.stats[name]!;
      const c = chain.stats[name];
      for (const part of ['base', 'boost', 'sync'] as const) {
        if (s[part] !== c[part]) {
          problems.push({ index, band, stat: name, part, served: s[part], chain: c[part] });
        }
      }
      // the client's own formula, on the CHAIN's parts — this is the
      // assertion that the effective value is not a re-derivation
      const expectedTotal = (1 + c.boost / 1e3) * (c.base + c.shift);
      if (s.total !== expectedTotal) {
        problems.push({
          index,
          band,
          stat: name,
          part: 'total',
          served: s.total,
          chain: expectedTotal,
        });
      }
      if (s.shift !== c.shift) {
        // trap 2: bonus-inclusive vs stored. Reported, never tolerated silently.
        shiftDivergences.push({
          index,
          band,
          stat: name,
          servedShift: s.shift,
          chainShift: c.shift,
          impliedBonus: s.shift - c.shift,
        });
      }
      row[name] = { base: c.base, shift: c.shift, boost: c.boost, total: expectedTotal };
    }
    if (JSON.stringify(served.affinities) !== JSON.stringify(chain.affinities)) {
      problems.push({
        index,
        band,
        reason: 'affinity pair differs from chain',
        served: served.affinities,
        chain: chain.affinities,
      });
    }
    row.affinities = chain.affinities;
    rows.push(row);
  }
}
await Promise.all(Array.from({ length: POOL }, () => worker()));
rows.sort((a, b) => (a.index as number) - (b.index as number));

// --- the unowned-revert finding, probed on purpose and RECORDED ------------
// SPREAD ACROSS THE INDEX SPACE, for the same reason the owned sample is: the
// first run took the first eight in mirror-iteration order, got eight
// low-index kamis, and would have recorded a finding the high indices
// contradict.
const unownedProbe: Record<string, unknown>[] = [];
{
  const all = [...unowned].sort((a, b) => a.index - b.index);
  const want = Math.min(12, all.length);
  const stride = Math.max(1, Math.floor(all.length / Math.max(1, want)));
  for (let i = 0, taken = 0; i < all.length && taken < want; i += stride, taken++) {
    const { index, state } = all[i]!;
    const chain = await readChainKami(index);
    unownedProbe.push({ index, state, chain: 'revert' in chain ? 'REVERT' : 'answered' });
  }
}
const unownedReverted = unownedProbe.filter((p) => p.chain === 'REVERT').length;
/** the grouping, derived — state -> {answered, reverted} */
const unownedByState: Record<string, { answered: number; reverted: number }> = {};
for (const p of unownedProbe) {
  const k = String(p.state);
  unownedByState[k] ??= { answered: 0, reverted: 0 };
  if (p.chain === 'REVERT') unownedByState[k]!.reverted += 1;
  else unownedByState[k]!.answered += 1;
}

provider.destroy();

const elapsedMs = Date.now() - t0;
const headAfter = await (async () => {
  const p2 = makeProvider(config);
  try {
    return await p2.getBlockNumber();
  } catch {
    return null;
  } finally {
    p2.destroy();
  }
})();

const file = await writeMeasurement('g2d-stats-chain', {
  pinnedBlock,
  snapshotBase: path.basename(snapshotArg),
  snapshotBlock,
  blocksReplayed: pinnedBlock - snapshotBlock,
  headAfterVerify: headAfter,
  blocksBehindAtEnd: headAfter === null ? null : headAfter - pinnedBlock,
  elapsedMs,
  systemsRegistry,
  getterAddress,
  sampled: sample.length,
  perBand,
  rows,
  shiftDivergences,
  shiftNote:
    'the mirror serves a BONUS-INCLUSIVE shift (getStats withBonus=true); the chain returns the stored component value. An empty list means no sampled kami carries a STAT_*_SHIFT bonus. A non-empty list is a finding: add an explicit shiftBonus field and assert shift === chainShift + shiftBonus.',
  unownedProbe,
  unownedReverted,
  unownedTotalInMirror: unowned.length,
  unownedByState,
  unownedNote:
    `${unownedReverted} of ${unownedProbe.length} probed account-less kamis reverted. The per-index rows and the unownedByState grouping ARE the finding; this sentence is not. Observed so far: an account-less kami in state 721_EXTERNAL (bridged out of the world) is still resolved by the getter, while an account-less kami still in-world reverts. Recorded, not asserted — the mirror is not wrong to serve a kami the getter declines to describe, and the owned-only sampling above is the consequence either way.`,
  problems,
  match: problems.length === 0,
});

if (problems.length > 0) {
  fail('G2.d', { problems: problems.slice(0, 20), measurement: file });
}
if (shiftDivergences.length > 0) {
  fail('G2.d', {
    reason: 'served shift diverges from the chain-stored shift — add an explicit shiftBonus field (see the header)',
    divergences: shiftDivergences.slice(0, 20),
    measurement: file,
  });
}
pass('G2.d', {
  sampled: sample.length,
  perBand,
  pinnedBlock,
  unownedProbed: unownedProbe.length,
  unownedReverted,
  elapsedMs,
  measurement: file,
});
