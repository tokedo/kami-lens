// Gate G4 shared mechanics: warm daemon spawn + socket client (the
// G3.d/G3.e pattern, factored), and the independent envelope walker
// (mirrors gates/g3/f-envelope.mts's derivation — kept separate from the
// production classifyPaths so the check stays two-implementation).

import { spawn, ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import path from 'node:path';

import { ARTIFACTS_DIR, REPO_ROOT, sleep } from '../g1/lib.mts';

export const DATA_DIR = path.join(ARTIFACTS_DIR, 'overnight-data');
export const SOCK = path.join(DATA_DIR, 'kami-lens.sock');

export type DaemonHandle = {
  proc: ChildProcess;
  exited: Promise<number | null>;
  stop: () => Promise<void>;
};

/** Spawn the CLI daemon (warm data dir) and wait for LIVE. */
export async function spawnDaemonLive(
  env: Record<string, string> = {},
  timeoutS = 300
): Promise<DaemonHandle> {
  const proc = spawn('npx', ['tsx', '--tsconfig', 'tsconfig.json', 'src/cli.ts', 'daemon'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      KAMI_LENS_DATA_DIR: DATA_DIR,
      NODE_OPTIONS: '--max-old-space-size=8192',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let live = false;
  proc.stdout!.on('data', (d: Buffer) => {
    if (d.toString().includes('"state":"LIVE"')) live = true;
  });
  proc.stderr!.on('data', () => {});
  const exited = new Promise<number | null>((resolve) => proc.on('close', resolve));
  for (let i = 0; i < timeoutS && !live; i++) await sleep(1000);
  if (!live) {
    proc.kill('SIGKILL');
    throw new Error(`daemon did not reach LIVE within ${timeoutS} s`);
  }
  await sleep(3000); // let the stream settle past backfill
  const stop = async () => {
    proc.kill('SIGTERM');
    const graceful = await Promise.race([exited.then(() => true), sleep(30_000).then(() => false)]);
    if (!graceful) proc.kill('SIGKILL');
  };
  return { proc, exited, stop };
}

export type SocketResponse = {
  ok: boolean;
  data?: unknown;
  untrusted?: string[];
  meta?: { blockNumber: number; stale: boolean; suppressed?: string[] };
  error?: { code: string; message: string };
};

export function socketQuery(
  query: string,
  args: string[] = [],
  flags: { prose?: boolean; noAuthored?: boolean; oversize?: boolean } = {}
): Promise<SocketResponse> {
  return new Promise((resolve, reject) => {
    const conn = connect(SOCK);
    let buffer = '';
    conn.on('connect', () => conn.write(JSON.stringify({ id: 1, query, args, ...flags }) + '\n'));
    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl >= 0) {
        conn.end();
        resolve(JSON.parse(buffer.slice(0, nl)) as SocketResponse);
      }
    });
    conn.on('error', reject);
  });
}

// ---- independent envelope derivation (the g3/f walker, restated) ----------

type Cls = Record<string, Record<string, string>>;
type SchemaNode = {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  $ref?: string;
};

/** Derive the authored-class string paths from (schema × classification),
 * independently of src/queries/envelope.ts. */
export function deriveAuthoredPaths(
  schema: { $defs?: Record<string, SchemaNode> } & SchemaNode,
  classification: { default: string; types: Cls }
): string[] {
  const defs = schema.$defs ?? {};
  const out: string[] = [];
  const visit = (node: SchemaNode, p: string, owner?: string): void => {
    if (node.$ref) {
      const name = node.$ref.replace('#/$defs/', '');
      const target = defs[name];
      if (!target) throw new Error(`unresolvable $ref ${node.$ref}`);
      return visit(target, p, name);
    }
    if (node.type === 'string') {
      const leaf = (p.split('.').pop() ?? '').replace(/\[\]$/, '');
      const cls = (owner && classification.types[owner]?.[leaf]) || classification.default;
      if (cls === 'authored-id' || cls === 'authored-prose') out.push(p);
      return;
    }
    if (node.type === 'object' && node.properties) {
      for (const [k, child] of Object.entries(node.properties)) {
        visit(child, p === '' ? k : `${p}.${k}`, owner);
      }
      return;
    }
    if (node.type === 'array' && node.items) visit(node.items, `${p}[]`, owner);
  };
  visit(schema, '');
  return out;
}

/** Which derived paths are present in a response value (array-aware). */
export function presentPath(data: unknown, pathExpr: string): boolean {
  let frontier: unknown[] = [data];
  for (const seg of pathExpr.split('.')) {
    const isArray = seg.endsWith('[]');
    const key = isArray ? seg.slice(0, -2) : seg;
    const next: unknown[] = [];
    for (const v of frontier) {
      if (v == null || typeof v !== 'object') continue;
      const child = (v as Record<string, unknown>)[key];
      if (child === undefined) continue;
      if (isArray) {
        if (Array.isArray(child)) next.push(...child);
      } else next.push(child);
    }
    frontier = next;
    if (frontier.length === 0) return false;
  }
  return frontier.some((v) => v !== undefined && v !== null);
}
