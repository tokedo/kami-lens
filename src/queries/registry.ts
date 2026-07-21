// kami-lens native module (not a port): the query registry (DESIGN §4.3).
// One entry per served query: argument parsing (shared by CLI and socket),
// the checked-in output schema, and the mirror-backed builder. The same
// registry backs the daemon socket, the CLI, and the library exports —
// "the same queries as library exports" is a table property, not a promise.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  accountQuery,
  configQuery,
  itemQuery,
  itemsQuery,
  kamiQuery,
  Mirror,
  nodeQuery,
  partyQuery,
  QueryError,
} from './build';
import { EnvelopeOptions, QuerySchema } from './envelope';

export type QueryName = 'kami' | 'account' | 'node' | 'party' | 'item' | 'items' | 'config';

export type QueryDef = {
  name: QueryName;
  summary: string;
  /** positional CLI args → builder args; throws QueryError on bad input */
  parseArgs: (positional: string[]) => Record<string, unknown>;
  /** true when the query is servable without a daemon (G3.d) */
  stateless: boolean;
  build: (mirror: Mirror, args: Record<string, unknown>, opts: EnvelopeOptions) => unknown;
};

const int = (s: string | undefined, what: string): number => {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) throw new QueryError('BAD_ARGS', `${what} must be a non-negative integer`);
  return n;
};

export const REGISTRY: Record<QueryName, QueryDef> = {
  kami: {
    name: 'kami',
    summary: 'single-kami vitals by on-chain index',
    parseArgs: ([index]) => ({ index: int(index, 'kami index') }),
    stateless: true,
    build: (m, a) => kamiQuery(m, a as { index: number }),
  },
  account: {
    name: 'account',
    summary: 'account by index or name (bio only with --prose)',
    parseArgs: ([key]) => {
      if (key === undefined) throw new QueryError('BAD_ARGS', 'account needs an index or name');
      return /^\d+$/.test(key) ? { index: Number(key) } : { name: key };
    },
    stateless: false,
    build: (m, a, o) => accountQuery(m, a as { index?: number; name?: string }, o),
  },
  node: {
    name: 'node',
    summary: 'node with its ACTIVE harvests (discovery query)',
    parseArgs: ([index]) => ({ index: int(index, 'node index') }),
    stateless: false,
    build: (m, a) => nodeQuery(m, a as { index: number }),
  },
  party: {
    name: 'party',
    summary: 'account party report: every kami with full vitals',
    parseArgs: ([accountIndex]) => ({ accountIndex: int(accountIndex, 'account index') }),
    stateless: false,
    build: (m, a) => partyQuery(m, a as { accountIndex: number }),
  },
  item: {
    name: 'item',
    summary: 'item registry row by index',
    parseArgs: ([index]) => ({ index: int(index, 'item index') }),
    stateless: false,
    build: (m, a) => itemQuery(m, a as { index: number }),
  },
  items: {
    name: 'items',
    summary: 'the full item registry',
    parseArgs: () => ({}),
    stateless: false,
    build: (m) => itemsQuery(m),
  },
  config: {
    name: 'config',
    summary: 'one is.config field value (--array for packed arrays)',
    parseArgs: ([name, flag]) => {
      if (!name) throw new QueryError('BAD_ARGS', 'config needs a field name');
      return { name, array: flag === '--array' };
    },
    stateless: false,
    build: (m, a) => configQuery(m, a as { name: string; array?: boolean }),
  },
};

const SCHEMA_DIR = path.resolve(import.meta.dirname, 'schemas');
const schemaCache = new Map<string, QuerySchema>();

/** The checked-in output schema for a query (status included — it is served
 * by the daemon rather than built from the mirror, but its contract is
 * checked the same way). */
export function loadSchema(name: QueryName | 'status'): QuerySchema {
  let s = schemaCache.get(name);
  if (!s) {
    s = JSON.parse(readFileSync(path.join(SCHEMA_DIR, `${name}.json`), 'utf8')) as QuerySchema;
    schemaCache.set(name, s);
  }
  return s;
}

export const QUERY_NAMES = Object.keys(REGISTRY) as QueryName[];
