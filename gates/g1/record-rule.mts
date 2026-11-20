// kami-lens native module (not a port): what a committed gate record may hold.
//
// 1.2.0: live gate records hold aggregates only. A record under
// docs/measurements/ is published with the repository, so it never names a
// player: no kami index or name, no account index / name / address, no owner
// or operator, no harvest or entity id, no per-row values. What survives is
// what was compared (counts), the block, the version and pin, the verdict, and
// for a mismatch its field name and the two values. writeMeasurement and G9's
// writer apply this to every record they write; test/record-rule.test.ts
// holds the rule, through both writers.
//
// THE SHAPE IS DEFAULT-DENY wherever per-entity data can enter a record:
//   - a list of rows is published as its length; a mismatch-class list keeps,
//     per element, only a field name and the two compared values (scalars);
//   - a list of numbers is kept only under a named measurement series,
//     otherwise published as its length;
//   - an object keyed by numbers or hex is published as its entry count,
//     unless it is a named histogram;
//   - a 40- or 64-hex string (or a 60+ digit decimal) is kept only when every
//     such value in it is a listed public constant: the World, system and
//     component addresses and ids, upstream commits;
//   - free text (values and keys) naming a kami / account / owner / operator
//     / harvest / entity by a number is dropped — a note is a fixed string
//     chosen by the gate, never one interpolated with an entity;
//   - a unix time in seconds or milliseconds (a number, or a string of
//     digits) is kept only under a listed clock key — the time of an
//     on-chain action is a key to its transaction;
//   - a key that names an identity is dropped whatever its value, unless it
//     is a listed count or a listed feature name.
// Scalars under ordinary keys stay: they are the gate's own aggregates, and a
// full key allow-list across every gate's record would be a second schema per
// gate that drifts with each one; the deny applies where rows can come in.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ComponentsSchema } from '../../src/types/ComponentsSchema';

/** keys that name an entity or a player, whatever their value */
const IDENTITY_KEYS = new Set([
  'index', 'id', 'name', 'address', 'entity', 'entityId',
  'kami', 'kamiIndex', 'kamiId', 'kamiName', 'kamis',
  'account', 'accountIndex', 'accountId', 'accountName', 'accounts',
  'owner', 'ownerAddress', 'operator', 'operatorAddress', 'holder',
  'harvest', 'harvestId', 'harvestIds',
  'victim', 'killer', 'attacker', 'target', 'targets',
]);
/** a key that names one: a bare entity word, or a camelCase key ending in one
 * (with an optional index / id / name / address suffix) */
const IDENTITY_KEY_PATTERN =
  /^(kami|account|owner|operator|holder|player|wallet|victim|killer|attacker|target|entity|harvest|sender|recipient)s?(Index|Indices|Id|Ids|Name|Names|Address|Addresses)?$|^entities$|(Kami|Account|Owner|Operator|Holder|Player|Wallet|Victim|Killer|Attacker|Target|Entity|Entities|Harvest|Sender|Recipient)(s|Index|Indices|Id|Ids|Name|Names|Address|Addresses)?$|accountsTried/;
/** identity-shaped keys that hold a count or a ratio */
const COUNT_KEYS = new Set([
  'entities', 'numEntities', 'marketAccounts', 'activeHarvests', 'distinctKamis', 'driftSampleTarget',
  'comparisonsPerKami', 'questRowsWithAccount', 'receiptsTotalForItsAccount',
  'partyMarginalBytesPerKami', 'rosterMarginalBytesPerKami', 'flagOffMarginalBytesPerKami',
]);
/** identity-shaped keys that name a feature or a check, not an entity
 * (their contents still go through the rule) */
const FEATURE_KEYS = new Set(['blockedAttacker', 'largestAccountHolder', 'shardHolders']);

/** arrays kept element by element: a mismatch's field and its two values */
const MISMATCH_KEYS = /mismatch|problem|violation|divergen|failure/i;
/** what a mismatch element may keep: the field it names ... */
const MISMATCH_FIELD_KEYS = new Set(['field', 'path', 'key', 'leaf', 'check', 'query', 'area', 'type', 'reason']);
/** ... and the two values compared (scalars only) */
const MISMATCH_VALUE_KEYS = new Set([
  'was', 'now', 'want', 'got', 'expected', 'actual', 'lens', 'chain', 'mirror', 'served', 'onChain', 'before', 'after',
]);

/** lists of numbers that are a measurement series, not entity indices */
const NUMBER_SERIES_KEYS = new Set([
  'deltas', // zero-bias differences, lens minus display
  'items', // a pool's two item indices — public world constants
  'reserves', 'reservesAfter', 'values', // pool reserves, a config's values
  'kamigazeEventCounts', 'retryDelaysObservedS', 'stampBelowStateBlockBlocks',
]);
/** objects keyed by a number that are histograms (the key is a measured amount) */
const HISTOGRAM_KEYS = new Set(['lagBlocksWhenShort', 'regressionDepthBlocks']);

/** clock values that are not the time of an action: a gate's pinned clock,
 * the measuring machine's clock, a world cycle's start, a phase boundary */
const CLOCK_KEYS = new Set(['clockPinSec', 'pin', 'nowMs', 'cycleStart', 'at']);
const isUnixTime = (v: unknown): boolean => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{10}(\d{3})?$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && ((n >= 1.5e9 && n <= 2.1e9) || (n >= 1.5e12 && n <= 2.1e12));
};

/** public constants a record may name in full */
const PUBLIC_HEX = new Set<string>(
  [
    '0x2729174c265dbBd8416C6449E0E813E88f43D0E7', // the World
    '0x3B9B1223d876968B8Ba319CDdD4B4B6739B462AA', // the systems registry
    '0x991db571eafa031624a0bb11bf48341b15b822a6', // GetterSystem
    '0x12c0989a259471d89d1ba1bb95043d64daf97c19', // GetterSystem (earlier deploy)
    '0xC0F68a99ECD458E9d7fC162Ac5B1f8a21F1D2ac4', // the HarvestMultiplier component
    // upstream commits the lens has been pinned to
    'a99b4b64b505b722203b2337f76a5b604539c1e0',
    '8fb6ea58be5f773909a4d6d8db32f4726512b8e0',
    'ffda396330af1bc33238b6c37188772152b45439',
    '04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad',
    'ef898fc9350a6085fb080419b12af96c2254e8f3',
    ...currentPin(),
    // every component id the schema registers
    ...Object.keys(ComponentsSchema),
  ].map((h) => h.toLowerCase().replace(/^0x/, ''))
);

function currentPin(): string[] {
  try {
    const text = readFileSync(path.resolve(import.meta.dirname, '..', '..', 'UPSTREAM'), 'utf8');
    const m = /^commit\s+([0-9a-f]{40})/m.exec(text);
    return m ? [m[1]!] : [];
  } catch {
    return [];
  }
}

/** 40- or 64-hex runs (with or without 0x), and 60+ digit decimals */
const HEX_RUN = /(?<![0-9a-fA-F])(?:0x)?([0-9a-fA-F]{64}|[0-9a-fA-F]{40})(?![0-9a-fA-F])/g;
const LONG_DECIMAL = /(?<![0-9])[0-9]{60,}(?![0-9])/;
/** an entity named by a number in free text: "kami 7799", "account #12", "operator index: 3" */
const TEXT_IDENTITY =
  /\b(kami|account|owner|operator|player|holder|wallet|attacker|victim|killer|target|harvest|entity|sender|recipient)s?\s*(index|idx|id|no\.?|number)?\s*[#:=]?\s*\d/i;

/** a string a record may hold */
export function textAllowed(s: string): boolean {
  if (LONG_DECIMAL.test(s)) return false;
  if (TEXT_IDENTITY.test(s)) return false;
  for (const m of s.matchAll(HEX_RUN)) if (!PUBLIC_HEX.has(m[1]!.toLowerCase())) return false;
  return true;
}

const isRow = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
/** a key that is an index or an id: digits, or a hex run */
const ENTITY_KEY = /^(\d+|(0x)?[0-9a-fA-F]{8,})$/;

function keyAllowed(k: string): boolean {
  if (!textAllowed(k)) return false;
  if (IDENTITY_KEYS.has(k)) return false;
  return true;
}

function mismatchElement(v: unknown): unknown {
  if (!isRow(v)) return isScalar(v) && (typeof v !== 'string' || textAllowed(v)) ? v : undefined;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!MISMATCH_FIELD_KEYS.has(k) && !MISMATCH_VALUE_KEYS.has(k)) continue;
    if (!isScalar(x)) continue;
    if (typeof x === 'string' && !textAllowed(x)) continue;
    if (isUnixTime(x)) continue;
    out[k] = x;
  }
  return out;
}

export function aggregatesOnly(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    if (MISMATCH_KEYS.test(key)) return value.map(mismatchElement).filter((v) => v !== undefined);
    // a list of rows is published as how many rows were compared
    if (value.some((v) => v !== null && typeof v === 'object')) return value.length;
    if (value.some((v) => typeof v === 'number')) {
      return NUMBER_SERIES_KEYS.has(key) && !value.some(isUnixTime) ? value : value.length;
    }
    return value.filter((v) => typeof v !== 'string' || textAllowed(v));
  }
  if (isRow(value)) {
    const keys = Object.keys(value);
    // an object keyed by an index or an id is published as its entry count
    if (!HISTOGRAM_KEYS.has(key) && keys.some((k) => ENTITY_KEY.test(k))) return keys.length;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!keyAllowed(k)) continue;
      if (IDENTITY_KEY_PATTERN.test(k) && !FEATURE_KEYS.has(k)) {
        if (!(COUNT_KEYS.has(k) && typeof v === 'number')) continue;
      }
      if (typeof v === 'string' && !textAllowed(v)) continue;
      if (isUnixTime(v) && !CLOCK_KEYS.has(k)) continue;
      out[k] = aggregatesOnly(v, k);
    }
    return out;
  }
  if (typeof value === 'string' && !textAllowed(value)) return null;
  return value;
}
