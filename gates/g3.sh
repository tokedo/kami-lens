#!/usr/bin/env bash
# Gate G3 — query surface (PORT_PLAN.md M3). Exits 0 only if every part
# exits 0.
#
#   G3.a [hermetic]  JSON contract — every query validates vs its schema
#   G3.b [live]      node occupancy cross-check (chain-verified discovery)
#   G3.c [live]      party report parity (G2.b fixtures protocol, reused)
#   G3.d [live]      stateless equivalence + REQUIRES_DAEMON refusal
#   G3.e [live]      degraded-state honesty (proxy-kill, stale stamping)
#   G3.f [hermetic]  envelope conformance (schema × classification)
#
# Needs: gates/.artifacts/c2.v8snap (mirror snapshot), the g2b fixtures +
# measurement (G3.c), and gates/.artifacts/overnight-data for the live
# daemon runs (G3.d/e run daemons sequentially on that data dir).
set -euo pipefail
cd "$(dirname "$0")/.."

export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192"
TSX="npx tsx --tsconfig tsconfig.json"

step() { printf '\n== %s ==\n' "$1"; }

step "G3.a JSON contract (hermetic)"
$TSX gates/g3/a-json-contract.mts

step "G3.f envelope conformance (hermetic)"
$TSX gates/g3/f-envelope.mts

step "G3.b node occupancy cross-check (live)"
$TSX gates/g3/b-node-occupancy.mts

step "G3.c party report parity (fixtures)"
$TSX gates/g3/c-party-parity.mts

step "G3.d stateless equivalence (live daemon cycle)"
$TSX gates/g3/d-stateless.mts

step "G3.e degraded-state honesty (live daemon + proxy kill)"
$TSX gates/g3/e-degraded.mts

printf '\nG3 PASS — all parts exited 0 (check docs/measurements/ for dated records)\n'
