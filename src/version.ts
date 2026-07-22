// kami-lens native module (not a port): version + upstream pin resolution
// (DESIGN §5; gate G5.d — `kami-lens --version` prints both). The package
// root is found by walking up from this module until a kami-lens
// package.json appears, so the same code works from src/ (tsx dev), dist/
// (packaged), and a global npm install; the UPSTREAM pin file ships in the
// package (`files` in package.json).

import { readFileSync } from 'node:fs';
import path from 'node:path';

export type VersionInfo = {
  version: string;
  /** upstream commit hash from the UPSTREAM pin file ('unknown' if the
   * file is missing — a packaging defect G5.d would catch) */
  upstreamPin: string;
};

let cached: VersionInfo | null = null;

export function findPackageRoot(startDir: string = import.meta.dirname): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name?: string;
      };
      if (pkg.name === 'kami-lens') return dir;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function getVersionInfo(): VersionInfo {
  if (cached) return cached;
  const root = findPackageRoot();
  let version = '0.0.0';
  let upstreamPin = 'unknown';
  if (root) {
    try {
      version = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;
    } catch {
      /* leave default */
    }
    try {
      const upstream = readFileSync(path.join(root, 'UPSTREAM'), 'utf8');
      const match = /^commit\s+([0-9a-f]{40})/m.exec(upstream);
      if (match) upstreamPin = match[1];
    } catch {
      /* leave 'unknown' */
    }
  }
  cached = { version, upstreamPin };
  return cached;
}
