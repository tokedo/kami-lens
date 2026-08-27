#!/usr/bin/env bash
# Gate G9 — pre-LIVE stall (0.5.2, DESIGN §3.2). MANUAL and [live]: it takes
# ~20 minutes of wall clock, most of it deliberately watching a control
# daemon fail to recover. Not part of any other gate script for that reason.
#
#   G9.a [live]  a cold daemon started with NO network, network restored
#                after 60 s. Control is the 0.5.1 tree (built from a git
#                worktree at f07b578) and is expected to wedge in SETUP 0%
#                indefinitely; 0.5.2 is expected to reach LIVE with no
#                kickstart. Records time-to-LIVE, bootstrap attempts counted,
#                the `degraded` strings seen (incl. pre-live-stall:<N>s) and
#                the NOT_READY text a world read got while pre-LIVE.
#
# THE SEVER METHOD IS AN ISOLATED DOCKER NETWORK NAMESPACE: `--network none`
# at start, `docker network connect bridge` to restore. NO host DNS, hosts
# file or firewall change — those would also cut the LIVE launchd kami-lens
# daemon on this Mac and the play session that depends on it. `dist` is
# dockerignored, so the host's built CLI is never written; the gate
# fingerprints it before and after and fails if it moved.
set -euo pipefail
cd "$(dirname "$0")/.."

export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192"
TSX="npx tsx --tsconfig tsconfig.json"

printf '\n== G9.a pre-LIVE stall (60 s outage, control vs fix) ==\n'
$TSX gates/g9/a-prelive-stall.mts

printf '\nG9 PASS — check docs/measurements/g9-prelive-stall-*.json\n'
