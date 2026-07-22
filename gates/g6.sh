#!/usr/bin/env bash
# Gate G6 — 0.2.0 query-surface additions (inventory, room, merchant,
# phase, leaderboard, killers, node vitals+liquidation, account stamina).
# Exits 0 only if every part exits 0. The schema/envelope contracts for the
# new queries are gated by the extended G3.a/G3.f (re-run them alongside);
# G6 carries the checks that are new in kind.
#
#   G6.a [hermetic]  cross-query consistency (vitals vs kami query,
#                    stamina recompute, inventory contract + MUSU
#                    cross-check, merchant price-side rules, phase
#                    boundary arithmetic, leaderboard rank contract)
#   G6.b [live]      chain cross-check — served inventory/room/merchant/
#                    leaderboard rows verified by pinned eth_call reads
#   G6.c [live]      killers conformance (live daemon; schema, envelope,
#                    joins, cross-service kills check, name-free mode) +
#                    the windowed-ranking deferral evidence measurement
#
# Needs: gates/.artifacts/c2.v8snap (mirror snapshot) and, for G6.c, the
# warm overnight-data dir (the G4 daemon pattern).
set -euo pipefail
cd "$(dirname "$0")/.."

export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192"
TSX="npx tsx --tsconfig tsconfig.json"

step() { printf '\n== %s ==\n' "$1"; }

step "G6.a cross-query consistency (hermetic)"
$TSX gates/g6/a-consistency.mts

step "G6.b chain cross-check (live)"
$TSX gates/g6/b-chain-crosscheck.mts

step "G6.c killers conformance + deferral evidence (live daemon)"
$TSX gates/g6/c-killers.mts

printf '\nG6 PASS — all parts exited 0 (check docs/measurements/ for dated records)\n'
