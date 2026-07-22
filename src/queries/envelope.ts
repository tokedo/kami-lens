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

export type Envelope<T> = {
  data: T;
  untrusted: string[];
  meta: {
    servedAt: string;
    blockNumber: number;
    stale: boolean;
    mode: 'daemon' | 'stateless';
    suppressed?: string[];
  };
};

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
      ...(suppressed.length > 0 ? { suppressed: suppressed.sort() } : {}),
    },
  };
}
