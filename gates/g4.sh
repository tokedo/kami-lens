#!/usr/bin/env bash
# Gate G4 — Kamiden feeds (PORT_PLAN.md M4). Exits 0 only if every part
# exits 0.
#
#   G4.a [live]           unary feed conformance — all 12 served methods
#                         called live, schema-valid, entity ids resolve;
#                         history depth recorded, never asserted
#   G4.b [live+hermetic]  stream feed cross-check — hermetic ingestion-drop
#                         + ring-buffer proof, then a live window: kills →
#                         mirror state delta, movements → RoomIndex, chat
#                         exclusion measured at the topic filter and
#                         guaranteed at ingestion
#   G4.c [live+hermetic]  chat plan conformance — oversize
#                         withhold-with-receipt, prose tagging, name-free
#                         receipts, never-in-reports sweep, kill-switch
#                         (hermetic ctx + live daemon cycle)
#
# Needs: gates/.artifacts/c2.v8snap (G4.c hermetic mirror) and
# gates/.artifacts/overnight-data (warm daemon runs; the three parts run
# daemons sequentially on that data dir). Kamiden must be reachable —
# these are [live] parts by design; an outage fails the run loudly.
#
# Tunables: G4B_WINDOW_S (default 1200), G4B_MIN_KILLS (1),
#           G4B_MIN_MOVES (5).
set -euo pipefail
cd "$(dirname "$0")/.."

export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192"
TSX="npx tsx --tsconfig tsconfig.json"

step() { printf '\n== %s ==\n' "$1"; }

step "G4.a unary feed conformance (live)"
$TSX gates/g4/a-unary.mts

step "G4.b stream feed cross-check (hermetic ingestion proof + live window)"
$TSX gates/g4/b-stream.mts

step "G4.c chat plan conformance (hermetic + live)"
$TSX gates/g4/c-chat.mts

printf '\nG4 PASS — all parts exited 0 (check docs/measurements/ for dated records)\n'
