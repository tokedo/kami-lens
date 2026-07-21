// kami-lens native module (not a port): the query surface (DESIGN §4.3).
// serveQuery is the one entry point behind the daemon socket, the CLI and
// the library: registry lookup → builder → §3.10 envelope. Async since M4
// (Kamiden unary passthroughs); chain-only callers may still pass a bare
// Mirror — it is wrapped into a QueryCtx without feed access, and
// kamiden-backed queries then answer KAMIDEN_UNAVAILABLE, visibly.

import { Mirror, QueryError } from './build';
import { buildEnvelope, Envelope, EnvelopeOptions } from './envelope';
import { QueryCtx } from './feeds';
import { loadSchema, QUERY_NAMES, QueryName, REGISTRY } from './registry';

export type { Envelope, EnvelopeOptions } from './envelope';
export { buildEnvelope, classifyPaths, loadClassification } from './envelope';
export type { Mirror } from './build';
export { QueryError } from './build';
export type { QueryCtx } from './feeds';
export { loadSchema, QUERY_NAMES, REGISTRY } from './registry';
export type { QueryName } from './registry';

function toCtx(target: Mirror | QueryCtx): QueryCtx {
  return 'mirror' in target ? target : { mirror: target };
}

export async function serveQuery(
  target: Mirror | QueryCtx,
  name: string,
  positional: string[],
  opts: EnvelopeOptions & { stale: boolean; mode: 'daemon' | 'stateless'; oversize?: boolean }
): Promise<Envelope<unknown>> {
  const def = REGISTRY[name as QueryName];
  if (!def) {
    throw new QueryError('BAD_ARGS', `unknown query '${name}' (have: ${QUERY_NAMES.join(', ')})`);
  }
  const ctx = toCtx(target);
  const args = def.parseArgs(positional);
  const data = await def.build(ctx, args, opts);
  return buildEnvelope(
    data,
    loadSchema(def.name),
    { blockNumber: ctx.mirror.blockNumber, stale: opts.stale, mode: opts.mode },
    def.forcesProse ? { ...opts, prose: true } : opts
  );
}
