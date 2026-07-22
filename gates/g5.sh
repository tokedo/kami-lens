#!/usr/bin/env bash
# Gate G5 — packaging (PORT_PLAN.md M5). Exits 0 only if every part
# exits 0.
#
#   G5.d [hermetic]  provenance — LICENSE, AGPL license field, --version
#                    shows the pin, provenance banners across src
#   G5.c [hermetic]  config precedence matrix — flag > env > file >
#                    default, pairwise, resolver + status provenance
#   G5.a [live]      clean-room install — npm pack → node:20 container →
#                    zero-config daemon LIVE → schema-valid sample query
#   G5.b [live]      container lifecycle — image build, volume, cold
#                    healthy, restart → warm bootstrap beats cold
#
# Needs: docker (colima with --memory 8 on this machine) for a and b.
set -euo pipefail
cd "$(dirname "$0")/.."

export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192"
TSX="npx tsx --tsconfig tsconfig.json"

step() { printf '\n== %s ==\n' "$1"; }

step "build (dist for G5.d --version and the pack steps)"
npm run build

step "G5.d provenance (hermetic)"
$TSX gates/g5/d-provenance.mts

step "G5.c config precedence matrix (hermetic)"
$TSX gates/g5/c-config.mts

step "G5.a clean-room install (live, docker)"
$TSX gates/g5/a-cleanroom.mts

step "G5.b container lifecycle (live, docker)"
$TSX gates/g5/b-container.mts

printf '\nG5 PASS — all parts exited 0 (check docs/measurements/ for dated records)\n'
