#!/usr/bin/env bash
# Gate G7 — 0.3.0 query-surface additions (per-objective quest progress,
# account-relative quest state, item pools by payload enrichment, the
# compact roster query, the starter-vendor display window). Exits 0 only if
# every part exits 0. Schema and envelope contracts for these additions are
# carried by the extended G3.a/G3.f (re-run them alongside); G7 carries the
# checks that are new in kind.
#
#   G7.a [hermetic]  quest progress recompute + the pre-acceptance guard,
#                    account-state discrimination against the mirror's own
#                    queries, roster-vs-party agreement and the compaction
#                    measurement, pool row coherence, vendor cycle
#                    arithmetic, and the cost of the account-form quests
#                    answer
#   G7.b [live]      chain cross-check — every served pool row verified by
#                    pinned eth_call reads (type, pair, fee, share supply,
#                    creation time, both reserves), negative samples for
#                    unpooled pairs, the vendor window against the vendor
#                    entity, and the entity-type reverse-lookup probe
#
# Needs: gates/.artifacts/c2.v8snap (mirror snapshot). G7.b heals that
# snapshot to near head before reading, exactly as G6.b does, because the
# public RPC serves eth_call state only a shallow window deep.
#
# NOTE on evidence: item pools postdate the checked-in fixture snapshot, so
# G7.a's pool checks are vacuous on a fixture captured before pools existed
# — it says so loudly in its measurement rather than reporting coverage it
# does not have. G7.b is the pool rows' evidence.
set -euo pipefail
cd "$(dirname "$0")/.."

export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192"
TSX="npx tsx --tsconfig tsconfig.json"

step() { printf '\n== %s ==\n' "$1"; }

step "G7.a 0.3.0 surface consistency (hermetic)"
$TSX gates/g7/a-consistency.mts

step "G7.b pool + vendor chain cross-check (live)"
$TSX gates/g7/b-chain-crosscheck.mts

printf '\nG7 PASS — all parts exited 0 (check docs/measurements/ for dated records)\n'
