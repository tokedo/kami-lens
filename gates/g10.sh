#!/usr/bin/env bash
# Gate G10 — CDN cold boot (0.6.2, DESIGN §3.1). MANUAL and [live]: it cold-
# boots real daemons against the production state CDN and the production
# Kamigaze, and G10.c deliberately makes the ONE gRPC cold boot of the
# release. Not part of any other gate script for that reason.
#
#   G10.a [live]  a daemon on a FRESH data dir with the DEFAULT config (which
#                 since 0.6.2 means the state CDN is ON) reaches LIVE, and the
#                 log says the full load was served by the CDN, naming the
#                 export prefix. Records cold->LIVE wall time, the
#                 `[cdn] load profile` numbers, the longest progress-silent
#                 interval (against PRELIVE_STALL_MS 90 s — Worker.ts
#                 divergence 10), peak RSS, and the bridge path taken with
#                 the delta's block span. Since divergence 12 the bridge is
#                 DELTA-FIRST, so the question is not "did the delta run" (it
#                 always does) but "did it SUCCEED" — delta-ok means the
#                 gap-fill covered only the snapshot service's sync period,
#                 delta-failed means it log-scanned the whole window from the
#                 chain. A CDN load that never entered the bridge FAILS.
#
#   G10.b [live]  parity of what that boot loaded, against the SAME daemon
#                 while it is still LIVE: `sync.unhealedRanges` empty and the
#                 reconcile baseline seeded; the lab drift probe over 50
#                 settled facts vs the oracle -> zero divergences; and G3.b's
#                 node-occupancy cross-check re-run against a checkpoint of
#                 THIS daemon. Then the state counts against the local
#                 production daemon's newest checkpoint line — components
#                 EQUAL, entities and values ordered by the block delta.
#                 Runs in the same process as G10.a, the way G1.a/G1.b do,
#                 because "the same daemon, still LIVE" is the whole point.
#
#   G10.c [live]  a CDN URL that cannot serve a manifest must fall back to the
#                 gRPC cold start. The contract is "it takes the old path",
#                 NOT "the old path works": a gRPC cold boot that fails the
#                 way L-6 failed on the VM on 2026-09-12 is RECORDED, with
#                 the evidence that the fallback was entered, and the gate
#                 still reports the decision proven.
#
#   G10.d [hermetic]  runs in vitest, not here: test/cdn-full-load.test.ts.
#                 Nonce mismatch declines; a gone chunk restarts once from a
#                 newer manifest and rejects on the same block; a malformed
#                 manifest declines; a timed-out chunk is retried and then
#                 fatal. `npm test` covers it, and that file's header maps
#                 each case onto the test that carries it.
#
# DO NOT RUN G10.a MORE THAN THREE TIMES IN TOTAL. Each is a ~30 MB CDN pull:
# cheap, not free, and the point is one clean record rather than a sample.
#
# DATA DIRS. Both legs run on G10_DATA_DIR (default gates/.artifacts/g10-data,
# gitignored; G10.c uses that path + '-grpc') and DELETE it first to force a
# cold boot. Set G10_DATA_DIR to run them outside the repo. It must never name
# a data dir a live daemon owns — on this Mac that is
# ~/Library/Application Support/kami-lens, which no G10 leg writes to; G10.b
# reads the production daemon's LOG, read-only, and signals nothing.
#
# NO SECRETS ON A COMMAND LINE. The drift probe reads the oracle token from
# ~/.blocklife-keys/.env at call time and never prints it; nothing here passes
# it, echoes it, or writes it to a measurement (kami-lab hard rule 4).
set -euo pipefail
cd "$(dirname "$0")/.."

export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192"
TSX="npx tsx --tsconfig tsconfig.json"

# EXIT CODES ARE READ, NEVER INFERRED. `set -e` would abort the script before
# `rc=$?` ran, so each leg is guarded with `|| rc=$?` — the code is captured and
# PRINTED, then acted on. A gate that reports a number it never read is the
# failure mode this repo has been bitten by twice.
printf '\n== G10.a + G10.b CDN cold boot and parity (live, one daemon) ==\n'
rc=0
$TSX gates/g10/a-cold-boot.mts || rc=$?
printf 'G10.a+b exit %s\n' "$rc"
[ "$rc" -eq 0 ] || exit "$rc"

printf '\n== G10.c fallback: a dead CDN takes the gRPC cold start (live, ONCE) ==\n'
rc=0
$TSX gates/g10/c-fallback.mts || rc=$?
printf 'G10.c exit %s\n' "$rc"
[ "$rc" -eq 0 ] || exit "$rc"

printf '\nG10 PASS — check docs/measurements/g10a-cdn-cold-boot-*.json,\n'
printf '           g10b-cdn-parity-*.json and g10c-cdn-fallback-*.json\n'
