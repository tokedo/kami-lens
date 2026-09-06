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
 * mirror's newest. That anchor is named outright: `observedBlock` and
 * `observedBlockTime` are the block whose header timestamp produced the
 * current correction, `observedAgoMs` is how long ago that was, and
 * `clockOffsetMs` is the correction itself.
 *
 * The last four are ABSENT TOGETHER until the first clock observation
 * (§3.14, the §3.15 head-fields precedent): before it there is no
 * measurement, the offset is 0 because nothing was measured rather than
 * because the clocks agree, and a served 0 would read as evidence. */
export type AsOf = {
  /** mirror block, same value as `meta.blockNumber` — a LOWER BOUND (§3.15) */
  block: number;
  /** the offset-corrected instant every projection in this answer used */
  projectedAtSec: number;
  /** the block whose header timestamp produced the current correction; 0
   * when the observation did not name one */
  observedBlock?: number;
  /** that block's header timestamp (chain seconds) */
  observedBlockTime?: number;
  /** the correction itself. Measured live 2026-08-27 at −7.7 s to −17.4 s:
   * it is dominated by the Kamigaze stream's end-to-end lag, NOT by
   * wall-clock skew (§3.8) */
  clockOffsetMs?: number;
  /** wall-clock ms since that observation; bounded above by the 300 s clock
   * sync cadence in the healthy case and by NOTHING when the observation
   * keeps failing or the stream is stalled (§3.8) */
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

/** Build the §3.8 asOf block for one answer. */
export function buildAsOf(blockNumber: number): AsOf {
  const observation = clock.lastObservation();
  return {
    block: blockNumber,
    projectedAtSec: Math.floor(clock.now() / 1000),
    ...(observation
      ? {
          observedBlock: observation.blockNumber,
          observedBlockTime: observation.blockTimestampSec,
          clockOffsetMs: clock.offset(),
          observedAgoMs: Date.now() - observation.atWallMs,
        }
      : {}),
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
  type?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  $ref?: string;
  [k: string]: unknown;
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
    if (node.type === 'string') {
      const leaf = (atPath.split('.').pop() ?? '').replace(/\[\]$/, '');
      const listed = owner ? cls.types[owner]?.[leaf] : undefined;
      out.set(atPath, listed ?? cls.default);
      return;
    }
    if (node.type === 'object' && node.properties) {
      for (const [key, child] of Object.entries(node.properties)) {
        // the resolved owner propagates through anonymous nested objects
        walk(child, atPath === '' ? key : `${atPath}.${key}`, refName ?? defName);
      }
      return;
    }
    if (node.type === 'array' && node.items) {
      walk(node.items, `${atPath}[]`, refName ?? defName);
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
