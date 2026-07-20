#!/usr/bin/env bash
# Gate G0 (hermetic) — PORT_PLAN.md M0.
# Checks: clean install, lint, typecheck, build, and the known-vector tests
# (hashArgs vs LibConfig.genID, unpackArray32 vs LibPack.packArrU32, tuple
# packing round-trips, component-value decode tables). Exits 0 only if every
# step exits 0. No network beyond the npm registry; no live game services.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== G0.%s %s ==\n' "$1" "$2"; }

step 1 "clean install (npm ci)"
npm ci

step 2 "lint (eslint)"
npm run lint

step 3 "typecheck (tsc --noEmit)"
npm run typecheck

step 4 "build (tsup)"
npm run build

step 5 "known-vector tests (vitest)"
npm test

printf '\nG0 PASS — all steps exited 0\n'
