#!/usr/bin/env bash
# Gate G1 — sync core (PORT_PLAN.md M1). All parts [live] except e
# (hermetic-ish: e touches only the public RPC). Exits 0 only if every part
# exits 0. Live parts record dated measurements to docs/measurements/.
#
# G1C_MIN_SPAN_BLOCKS (default 600) sets the live-streaming span between the
# two G1.c checkpoints; the plan's full target is ~20 000 (≈12 h of daemon
# uptime) — shorter runs are recorded as provisional in the measurement.
set -euo pipefail
cd "$(dirname "$0")/.."

export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192"
TSX="npx tsx --tsconfig tsconfig.json"

step() { printf '\n== %s ==\n' "$1"; }

step "G1.e loud-fail cold start (no snapshot source)"
$TSX gates/g1/e-loudfail.mts

step "G1.f retention re-measure (bisection)"
$TSX gates/g1/f-retention.mts

step "G1.a bootstrap + G1.b mirror parity (live session; leaves C1/C2 + warm dir)"
$TSX gates/g1/a-bootstrap.mts

step "G1.c replay cross-validation (RPC vs Kamigaze path)"
$TSX gates/g1/c-replay.mts

step "G1.d warm restart vs fresh bootstrap"
$TSX gates/g1/d-restart.mts

printf '\nG1 PASS — all parts exited 0 (check docs/measurements/ for dated records)\n'
