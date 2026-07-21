// kami-lens native module (not a port): the query surface (DESIGN §4.3).
// serveQuery is the one entry point behind the daemon socket, the CLI and
// the library: registry lookup → builder → §3.10 envelope.

import { Mirror, QueryError } from './build';
import { buildEnvelope, Envelope, EnvelopeOptions } from './envelope';
import { loadSchema, QUERY_NAMES, QueryName, REGISTRY } from './registry';

export type { Envelope, EnvelopeOptions } from './envelope';
export { buildEnvelope, classifyPaths, loadClassification } from './envelope';
export type { Mirror } from './build';
export { QueryError } from './build';
export { loadSchema, QUERY_NAMES, REGISTRY } from './registry';
export type { QueryName } from './registry';

export function serveQuery(
  mirror: Mirror,
  name: string,
  positional: string[],
  opts: EnvelopeOptions & { stale: boolean; mode: 'daemon' | 'stateless' }
): Envelope<unknown> {
  const def = REGISTRY[name as QueryName];
  if (!def) {
    throw new QueryError('BAD_ARGS', `unknown query '${name}' (have: ${QUERY_NAMES.join(', ')})`);
  }
  const args = def.parseArgs(positional);
  const data = def.build(mirror, args, opts);
  return buildEnvelope(
    data,
    loadSchema(def.name),
    { blockNumber: mirror.blockNumber, stale: opts.stale, mode: opts.mode },
    opts
  );
}
