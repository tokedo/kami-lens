// kami-lens native module (not a port): the DESIGN §3.10 envelope.
//
// Every query response is `{data, untrusted: [<paths>], meta}` — values
// verbatim, the paths of authored-class strings listed, empty list when
// none. The path list is DERIVED from (the query's checked-in output schema
// × docs/string-classification.json), never hand-maintained; gate G3.f
// fails on divergence between an emitted envelope and the derivation.
//
// Path syntax: dot-joined properties with `[]` for array traversal, rooted
// at data — e.g. `kamis[].name`. A path is listed when it is PRESENT in the
// response data (schema-derived paths whose fields were pruned or withheld
// are not claimed).
//
// Composition (§3.10):
// - `authored-prose` is never volunteered: pruned from every default
//   output; only an explicit opt-in (`bio: true`) keeps a prose field, and
//   it is then envelope-tagged like any authored string.
// - `authored-id` (names) is inline by default, always tagged. The
//   name-free mode (`noAuthored: true`) withholds the value with receipt:
//   the field is deleted, `meta.suppressed` lists the withheld paths, and
//   stable IDs stay for joins.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as clock from 'clock';
import { QueryError } from './build';
import { tripwires } from '../tripwires';
import { syncHealth } from '../sync-health';

export type StringClass = 'authored-id' | 'authored-prose' | 'registry' | 'system';

export type Classification = {
  pin: string;
  default: StringClass;
  types: Record<string, Record<string, StringClass>>;
};

export type QuerySchema = {
  $defs?: Record<string, unknown>;
  [k: string]: unknown;
};

export type EnvelopeOptions = {
  /** opt-in: keep authored-prose fields (e.g. account bio) */
  prose?: boolean;
  /** name-free mode: withhold authored-id values with receipt */
  noAuthored?: boolean;
};

/** §3.8 (0.5.2): when this answer's projections were computed, and on what
 * evidence. ONE object, the same shape on every answer, so a caller pads
 * once rather than per query.
 *
 * The fields are kept SEPARATE on purpose and none of them is fused into a
 * derived claim. `block` is the mirror's lower bound (§3.15) and
 * `projectedAtSec` is the instant the projection math used; they are not the
 * same fact and pairing them as one would be a lie of convenience, because
 * the clock correction is anchored on a DIFFERENT, older block than the
 * mirror's newest.
 *
 * WHAT THE CLOCK SAMPLE IS, AND WHAT IT IS NOT (0.6.1). It is the block
 * whose header timestamp last calibrated the offset-corrected clock,
 * refreshed every `CLOCK_SYNC_INTERVAL_MS` = 300 s (src/daemon.ts syncClock),
 * so `clockSampleAgoMs` cycles 0-300 s on a perfectly healthy mirror. It is
 * NOT mirror lag and says nothing about applied state. Mirror lag is
 * `status.blockLag`; verified applied state is `meta.reconciledThrough`.
 *
 * This comment said as much from 0.5.2 and a consumer still misread the
 * fields as lag twice (hybrid-play ledger L-2, and again at the 0.6.0 sync),
 * gating play decisions on a number that was doing its job. A doc comment
 * loses to a field name every time, so 0.6.1 renames them: the fields are
 * `clockSampleBlock`, `clockSampleBlockTime` and `clockSampleAgoMs`.
 *
 * DEPRECATED ALIASES, ONE RELEASE ONLY (§1.4). `observedBlock`,
 * `observedBlockTime` and `observedAgoMs` remain, carrying identical values,
 * and are REMOVED in 0.7.0. All six travel with `clockOffsetMs`: seven
 * present together, or all seven absent together until the first clock
 * observation (§3.14, the §3.15 head-fields precedent) — before it there is
 * no measurement, the offset is 0 because nothing was measured rather than
 * because the clocks agree, and a served 0 would read as evidence. */
export type AsOf = {
  /** mirror block, same value as `meta.blockNumber` — a LOWER BOUND (§3.15) */
  block: number;
  /** the offset-corrected instant every projection in this answer used */
  projectedAtSec: number;
  /** the block whose header timestamp produced the current clock correction;
   * 0 when the observation did not name one. NOT the mirror's position — see
   * the type comment above. */
  clockSampleBlock?: number;
  /** that block's header timestamp (chain seconds) */
  clockSampleBlockTime?: number;
  /** the correction itself. Measured live 2026-08-27 at −7.7 s to −17.4 s:
   * it is dominated by the Kamigaze stream's end-to-end lag, NOT by
   * wall-clock skew (§3.8) */
  clockOffsetMs?: number;
  /** wall-clock ms since that clock sample. Cycles 0-300 s on a healthy
   * mirror (the sync cadence) and is bounded by NOTHING when the observation
   * keeps failing or the stream is stalled (§3.8). NOT mirror lag. */
  clockSampleAgoMs?: number;
  /** @deprecated 0.6.1, removed 0.7.0 — use `clockSampleBlock` */
  observedBlock?: number;
  /** @deprecated 0.6.1, removed 0.7.0 — use `clockSampleBlockTime` */
  observedBlockTime?: number;
  /** @deprecated 0.6.1, removed 0.7.0 — use `clockSampleAgoMs` */
  observedAgoMs?: number;
};

export type Envelope<T> = {
  data: T;
  untrusted: string[];
  meta: {
    servedAt: string;
    blockNumber: number;
    /** §3.15 (0.6.1): the lower bound of CHAIN-VERIFIED applied state — the
     * block through which every block has been re-read from the chain and
     * applied (§3.17). `null` before the baseline is seeded, and on any path
     * with no sync worker behind it (the stateless CLI): null means "this
     * process has verified nothing", never "verified through block 0".
     *
     * A reader comparing a transaction receipt's block SHOULD use this and
     * not `blockNumber` when it is present. `blockNumber` is a lower bound of
     * APPLIED state and advances on whatever the stream happened to deliver;
     * this one advances only over ranges read completely from the chain. */
    reconciledThrough: number | null;
    stale: boolean;
    mode: 'daemon' | 'stateless';
    asOf: AsOf;
    suppressed?: string[];
  };
};

/** Build the §3.8 asOf block for one answer.
 *
 * The clock-sample fields and their 0.6.1-deprecated aliases are emitted in
 * ONE conditional spread, deliberately: the contract is that they are present
 * together or absent together, and computing the aliases separately is how
 * that invariant would quietly stop being true. Each alias reads the same
 * expression as the field it mirrors — no second measurement. */
export function buildAsOf(blockNumber: number): AsOf {
  const observation = clock.lastObservation();
  // evaluation order preserved from 0.5.2: clock.now() before Date.now(), so
  // the rename moves no number at all
  const projectedAtSec = Math.floor(clock.now() / 1000);
  if (!observation) return { block: blockNumber, projectedAtSec };
  const clockSampleBlock = observation.blockNumber;
  const clockSampleBlockTime = observation.blockTimestampSec;
  const clockSampleAgoMs = Date.now() - observation.atWallMs;
  return {
    block: blockNumber,
    projectedAtSec,
    clockSampleBlock,
    clockSampleBlockTime,
    clockOffsetMs: clock.offset(),
    clockSampleAgoMs,
    // deprecated 0.6.1, removed 0.7.0 (§1.4): a rename ships both names for
    // exactly one release, same values.
    observedBlock: clockSampleBlock,
    observedBlockTime: clockSampleBlockTime,
    observedAgoMs: clockSampleAgoMs,
  };
}

// The classification artifact lives at <package root>/docs/. This module
// runs from src/queries/ (tsx dev: root is ../..) or from the dist/
// bundle (packaged: root is ..) — try both (M5 packaging).
const CLASSIFICATION_CANDIDATES = [
  path.resolve(import.meta.dirname, '..', '..', 'docs', 'string-classification.json'),
  path.resolve(import.meta.dirname, '..', 'docs', 'string-classification.json'),
];

let classification: Classification | null = null;
export function loadClassification(): Classification {
  if (classification) return classification;
  for (const candidate of CLASSIFICATION_CANDIDATES) {
    try {
      classification = JSON.parse(readFileSync(candidate, 'utf8')) as Classification;
      return classification;
    } catch {
      /* try the next layout */
    }
  }
  throw new Error(
    `string-classification.json not found (tried ${CLASSIFICATION_CANDIDATES.join(', ')}) — packaging defect`
  );
}

type SchemaNode = {
  /** a single type, or JSON Schema's list form — `['object', 'null']` for a
   * nullable block, which is what 0.6.3 fixed the walk to descend into */
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  $ref?: string;
  anyOf?: SchemaNode[];
  [k: string]: unknown;
};

/** Does this node admit `t`, however its schema spells the type?
 *
 * 0.6.3: before this, the walk compared `node.type === 'object'` and
 * `node.type === 'string'` against a bare string, so EVERY NULLABLE BLOCK
 * WAS SKIPPED — `checkpoint` since 0.2.0 and `lastFullLoad` since 0.6.2 are
 * `type: ['object', 'null']`, so the walk never descended and their
 * classification entries were inert. Silent in both directions: nothing
 * listed a path it should not have, and nothing was classified either, so a
 * string under a nullable block would have taken the artifact's default
 * without anybody choosing it. An `anyOf` with a null branch is the other
 * spelling of the same thing and is handled here too, rather than waiting
 * to be discovered by whichever schema uses it first. */
const admits = (node: SchemaNode, t: 'object' | 'string' | 'array'): boolean => {
  if (node.type === t) return true;
  if (Array.isArray(node.type) && node.type.includes(t)) return true;
  if (Array.isArray(node.anyOf)) return node.anyOf.some((branch) => admits(branch, t));
  return false;
};

/** Walk a query's output schema and derive, for every string-valued path,
 * its class — resolved by the owning named $def type × property, with the
 * artifact's fail-safe default for anything unlisted. Returns
 * path → class. */
export function classifyPaths(schema: QuerySchema): Map<string, StringClass> {
  const cls = loadClassification();
  const defs = (schema.$defs ?? {}) as Record<string, SchemaNode>;
  const out = new Map<string, StringClass>();

  const resolve = (node: SchemaNode): { node: SchemaNode; defName?: string } => {
    if (node.$ref) {
      const m = /^#\/\$defs\/(.+)$/.exec(node.$ref);
      if (!m || !defs[m[1]]) throw new Error(`unresolvable $ref ${node.$ref}`);
      return { node: defs[m[1]], defName: m[1] };
    }
    return { node };
  };

  const walk = (raw: SchemaNode, atPath: string, defName?: string): void => {
    const { node, defName: refName } = resolve(raw);
    const owner = refName ?? defName;
    if (admits(node, 'string')) {
      const leaf = (atPath.split('.').pop() ?? '').replace(/\[\]$/, '');
      const listed = owner ? cls.types[owner]?.[leaf] : undefined;
      out.set(atPath, listed ?? cls.default);
      return;
    }
    // `properties` may sit on the node itself or inside an anyOf branch
    // beside a null one — a nullable block, which before 0.6.3 was skipped
    // entirely (see `admits`).
    const properties =
      node.properties ?? node.anyOf?.find((branch) => branch.properties)?.properties;
    if (admits(node, 'object') && properties) {
      for (const [key, child] of Object.entries(properties)) {
        // the resolved owner propagates through anonymous nested objects
        walk(child, atPath === '' ? key : `${atPath}.${key}`, refName ?? defName);
      }
      return;
    }
    const items = node.items ?? node.anyOf?.find((branch) => branch.items)?.items;
    if (admits(node, 'array') && items) {
      walk(items, `${atPath}[]`, refName ?? defName);
    }
  };

  walk(schema as SchemaNode, '');
  return out;
}

/** Which of the derived paths actually exist in this response value. */
function presentPaths(data: unknown, pathExpr: string): boolean {
  const segs = pathExpr.split('.');
  let frontier: unknown[] = [data];
  for (const seg of segs) {
    const next: unknown[] = [];
    const isArray = seg.endsWith('[]');
    const key = isArray ? seg.slice(0, -2) : seg;
    for (const v of frontier) {
      if (v == null || typeof v !== 'object') continue;
      const child = (v as Record<string, unknown>)[key];
      if (child === undefined) continue;
      if (isArray) {
        if (Array.isArray(child)) next.push(...child);
      } else {
        next.push(child);
      }
    }
    frontier = next;
    if (frontier.length === 0) return false;
  }
  return frontier.some((v) => v !== undefined && v !== null);
}

function deletePath(data: unknown, pathExpr: string): void {
  const segs = pathExpr.split('.');
  let frontier: unknown[] = [data];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const isArray = seg.endsWith('[]');
    const key = isArray ? seg.slice(0, -2) : seg;
    const last = i === segs.length - 1;
    const next: unknown[] = [];
    for (const v of frontier) {
      if (v == null || typeof v !== 'object') continue;
      const obj = v as Record<string, unknown>;
      if (last && !isArray) {
        delete obj[key];
        continue;
      }
      const child = obj[key];
      if (child === undefined) continue;
      if (isArray) next.push(...(Array.isArray(child) ? child : []));
      else next.push(child);
    }
    frontier = next;
  }
}

/** §3.14: the serialization boundary. JSON.stringify renders NaN and
 * Infinity as `null`, which a consumer reads as a real answer — an HP of
 * `null` is indistinguishable from a field the world does not hold, and one
 * arm spent six days acting on exactly that. A pre-stringified rate is worse
 * still: it arrives as the literal string "NaN". Neither is repaired here,
 * because there is no honest value to repair it to; the answer is refused.
 *
 * Walks values only — cheap next to the projection that produced them, and
 * it is the last place a lie can be caught before it leaves the process. */
function findNonFinite(value: unknown, at = ''): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? null : `${at || '<root>'} = ${String(value)}`;
  }
  if (typeof value === 'string') {
    return value === 'NaN' || value === '-NaN' || value === 'Infinity' || value === '-Infinity'
      ? `${at || '<root>'} = "${value}"`
      : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findNonFinite(value[i], `${at}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const hit = findNonFinite(v, at ? `${at}.${k}` : k);
      if (hit) return hit;
    }
    return null;
  }
  return null;
}

/** Build the §3.10 envelope for a query response: prune never-volunteered
 * prose (unless opted in), apply name-free withholding with receipt, and
 * emit the derived-and-present untrusted path list. */
export function buildEnvelope<T>(
  data: T,
  schema: QuerySchema,
  meta: { blockNumber: number; stale: boolean; mode: 'daemon' | 'stateless' },
  options: EnvelopeOptions = {}
): Envelope<T> {
  const classes = classifyPaths(schema);
  const suppressed: string[] = [];

  for (const [p, c] of classes) {
    if (c === 'authored-prose' && !options.prose && presentPaths(data, p)) {
      deletePath(data, p);
      suppressed.push(p);
    }
    if (c === 'authored-id' && options.noAuthored && presentPaths(data, p)) {
      deletePath(data, p);
      suppressed.push(p);
    }
  }

  // §3.14: refuse rather than serve a plausible lie. Last check before the
  // answer leaves the process.
  const nonFinite = findNonFinite(data);
  if (nonFinite) {
    tripwires.nonFiniteValues += 1;
    throw new QueryError(
      'NOT_FINITE',
      `a projected value reached the serialization boundary as non-finite (${nonFinite}); JSON would have served it as null. The answer is refused rather than repaired.`
    );
  }

  const untrusted = [...classes.entries()]
    .filter(([, c]) => c === 'authored-id' || c === 'authored-prose')
    .filter(([p]) => presentPaths(data, p))
    .map(([p]) => p)
    .sort();

  return {
    data,
    untrusted,
    meta: {
      servedAt: new Date().toISOString(),
      ...meta,
      // §3.15 (0.6.1): the verified lower bound, on EVERY answer. It was
      // reachable only through `status.sync` before, which is not the answer
      // a reader is about to act on — and a consumer misread the CLOCK
      // anchor below as mirror lag twice for exactly that reason.
      reconciledThrough: syncHealth.reconciledThrough,
      // §3.8 (0.5.2): stamped here, in the ONE place every answer passes
      // through, so "the same shape everywhere" is structural rather than a
      // convention twenty-five builders are trusted to keep.
      asOf: buildAsOf(meta.blockNumber),
      ...(suppressed.length > 0 ? { suppressed: suppressed.sort() } : {}),
    },
  };
}
