#!/usr/bin/env bash
# Gate G8 — stream gap (0.5.1, DESIGN §4.1/§3.15). MANUAL and [live]: it takes
# ~40 minutes of wall clock, most of it deliberately doing nothing while the
# network is severed. Not part of any other gate script for that reason.
#
#   G8.b [live]  0.6.0 (DESIGN §3.17, L-1). THREE severs of ~20 s on a live
#                daemon — the FREQUENT gap the production server itself opens
#                every ~35 s, which is where the 2026-09-06 phantom-harvest
#                loss happened — recording per sever the reconnect time, the
#                heal path, every healed range with its log count and
#                duration, any deferral, and the `status.sync` block. Then the
#                question the 0.5.3 daemon could not answer about itself:
#                every ACTIVE harvest the mirror serves is cross-checked
#                against pinned eth_call reads, and an apparent divergence is
#                arbitrated by re-reading the mirror (skew vs phantom).
#                ~10-15 min.
#
#   G8.a [live]  daemon to LIVE in a container, network severed for 10 min,
#                restored; records time-to-reconnect, the gap-fill path taken
#                (Kamigaze GetEventsSince vs RPC), the RPC call count and
#                chunk size observed, time until `degraded` clears, and a
#                byte-equality check of a fixed query set against a fresh cold
#                daemon. Then the same gap with a RESTART instead — the lab's
#                restart-on-wake policy — so the two numbers sit side by side.
#
# THE SEVER METHOD IS `docker network disconnect` ON A DEDICATED CONTAINER.
# No sudo, no host routing change, and structurally unable to reach the
# launchd kami-lens service on this Mac or its data directory. The image
# builds inside Docker and `dist` is dockerignored, so the host's live
# dist/cli.js is never written — the gate fingerprints it before and after
# and fails if it moved.
#
# The 2-HOUR leg is deferred and dated in the measurement, not silently
# omitted.
set -euo pipefail
cd "$(dirname "$0")/.."

export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192"
TSX="npx tsx --tsconfig tsconfig.json"

printf '\n== G8.a stream gap (10 min sever + restart leg) ==\n'
$TSX gates/g8/a-stream-gap.mts

printf '\n== G8.b gap heal (3 x 20 s severs + chain cross-check) ==\n'
$TSX gates/g8/b-gap-heal.mts

printf '\nG8 PASS — check docs/measurements/g8-stream-gap-*.json and g8b-gap-heal-*.json\n'
