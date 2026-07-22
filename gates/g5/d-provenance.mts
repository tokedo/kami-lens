// Gate G5.d [hermetic] — provenance. LICENSE present (AGPL); package.json
// license is AGPL-3.0(-only); `--version` (from the BUILT dist) shows the
// UPSTREAM pin; and every source file carries a provenance banner — files
// claiming 'vendor port' must name the pin commit and an upstream path.
// (PORT_PLAN says spot-checked; the walk is cheap so it checks all.)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fail, pass, REPO_ROOT, writeMeasurement } from '../g1/lib.mts';

const checks: Record<string, boolean> = {};
const detail: Record<string, unknown> = {};

// LICENSE
const license = readFileSync(path.join(REPO_ROOT, 'LICENSE'), 'utf8');
checks.licenseFile = license.includes('GNU AFFERO GENERAL PUBLIC LICENSE');

// package.json license
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  version: string;
  license: string;
};
checks.packageLicense = /^AGPL-3\.0/.test(pkg.license);
detail.packageLicense = pkg.license;

// UPSTREAM pin
const upstream = readFileSync(path.join(REPO_ROOT, 'UPSTREAM'), 'utf8');
const pinMatch = /^commit\s+([0-9a-f]{40})/m.exec(upstream);
if (!pinMatch) fail('G5.d', { reason: 'UPSTREAM file has no commit line' });
const pin = pinMatch![1];

// --version from the built dist
const versionOut = execFileSync('node', [path.join(REPO_ROOT, 'dist', 'cli.js'), '--version'], {
  encoding: 'utf8',
});
checks.versionShowsVersion = versionOut.includes(pkg.version);
checks.versionShowsPin = versionOut.includes(pin);
detail.versionOutput = versionOut.trim();

// provenance banners across src/**/*.ts
import { readdirSync, statSync } from 'node:fs';
const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
};
const files = walk(path.join(REPO_ROOT, 'src'));
let vendor = 0;
let native = 0;
const badVendor: string[] = [];
const unmarked: string[] = [];
for (const f of files) {
  const head = readFileSync(f, 'utf8').slice(0, 1500);
  if (head.includes('kami-lens vendor port')) {
    vendor++;
    if (!head.includes(pin) || !head.includes('path:')) badVendor.push(path.relative(REPO_ROOT, f));
  } else if (
    // native modules, shims/partial ports, and vendored third-party deps
    // (e.g. @mud-classic — MIT banner naming package + provenance)
    /not a port|partial port|kami-lens shim|kami-lens partial|kami-lens vendored dependency/.test(head)
  ) {
    native++;
  } else {
    unmarked.push(path.relative(REPO_ROOT, f));
  }
}
checks.vendorHeadersComplete = badVendor.length === 0;
checks.noUnmarkedFiles = unmarked.length === 0;
detail.files = { total: files.length, vendor, native, badVendor: badVendor.slice(0, 10), unmarked: unmarked.slice(0, 10) };

await writeMeasurement('g5d-provenance', { pin, checks, ...detail, match: Object.values(checks).every(Boolean) });
if (!Object.values(checks).every(Boolean)) fail('G5.d', { checks, detail });
pass('G5.d', { files: files.length, vendor, native, version: pkg.version });
process.exit(0);
