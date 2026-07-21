#!/usr/bin/env bash
# Gate G2 — projection (PORT_PLAN.md M2). Exits 0 only if every part exits 0.
#
# Parts and their inputs:
#   G2.a [hermetic]  differential vs upstream calcs. Needs the mirror
#                    snapshot gates/.artifacts/c2.v8snap (from G1/daemon) and
#                    the pinned clone gates/.artifacts/upstream.
#   G2.b [live]      display parity vs the official client. Needs human-
#                    recorded fixtures at gates/fixtures/g2b-observations.json
#                    (see the template; observer account is an operational
#                    prerequisite).
#   G2.c [live]      clock-skew immunity. Needs two dumps produced
#                    CONCURRENTLY at the same target block — one in a
#                    ±120 s clock-skewed container, one unskewed:
#                      tsx gates/g2/c-clock-skew.mts dump \
#                        gates/.artifacts/g2c-skewed.json   <targetBlock>   # in container
#                      tsx gates/g2/c-clock-skew.mts dump \
#                        gates/.artifacts/g2c-unskewed.json <targetBlock>   # on host
set -euo pipefail
cd "$(dirname "$0")/.."

export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192"
TSX="npx tsx --tsconfig tsconfig.json"

step() { printf '\n== %s ==\n' "$1"; }

step "G2.a differential vs upstream calcs (hermetic)"
$TSX gates/g2/a-differential.mts

step "G2.b display parity vs official client (fixtures)"
$TSX gates/g2/b-display-parity.mts

step "G2.c clock-skew immunity (compare concurrent dumps)"
if [[ ! -f gates/.artifacts/g2c-skewed.json || ! -f gates/.artifacts/g2c-unskewed.json ]]; then
  echo "FAIL G2.c: dumps missing — produce gates/.artifacts/g2c-{skewed,unskewed}.json"
  echo "per the header of gates/g2/c-clock-skew.mts (skewed-container prerequisite)."
  exit 1
fi
$TSX gates/g2/c-clock-skew.mts compare gates/.artifacts/g2c-skewed.json gates/.artifacts/g2c-unskewed.json

printf '\nG2 PASS — all parts exited 0 (check docs/measurements/ for dated records)\n'
