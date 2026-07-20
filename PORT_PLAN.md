# kami-lens — Port Plan

Executes [DESIGN.md](DESIGN.md) (v1, 2026-07-20). Upstream pin:
`Asphodel-OS/kamigotchi` @ `ef898fc9` (recorded in the `UPSTREAM`
file from M0 onward).

## Gate philosophy

Every milestone ends in a **gate**: a script under `gates/` that
exits 0 on pass and non-zero on any failure, printing what it checked
and what it saw. A milestone is done when its gate scripts exit 0 on
a fresh run — never when logs look right, never on eyeball judgment.
Where a gate needs a human observation (reading the official client's
screen), the observation is entered as data into a fixtures file and
the *comparison* is scripted; the pass/fail judgment is always the
script's.

Gates that touch the live network are marked **[live]**; they record
the block height, date, and results into
`docs/measurements/<gate>-<date>.json` so every claim in DESIGN.md
stays traceable to a dated measurement. Hermetic gates run in CI.

State comparisons use a **canonical state hash**: the mirror's
`(componentId, entityId) → decoded value` map serialized in sorted
key order and SHA-256'd. Defined once, in the gates library, used by
every gate that says "state hash".

## M0 — Scaffold

**Scope**

- Repo scaffold: package layout (tsup/tsconfig, replacing Vite
  aliases — swap point 7), lint, CI.
- `UPSTREAM` pin file at repo root (commit + date).
- Vendor-port skeleton: each ported file carries a provenance header
  (upstream path @ pin) — AGPL attribution discipline.
- Port the pure leaf utilities first: `hashArgs`, `unpackArray32`,
  `packTuple`/`unpackTuple`, component-value decoding tables.

**Gate G0** *(hermetic)*

- Build + typecheck exit 0.
- Known-vector tests: `hashArgs(['is.config', <field>])` reproduces
  `LibConfig.genID` outputs for fixture fields (vectors generated
  once with an independent keccak implementation and checked in);
  `unpackArray32` inverts `LibPack.packArrU32` vectors bit-exactly;
  tuple packing round-trips.

## M1 — Sync core

**Scope**

- Port `workers/sync/**`, `engine/**` (recs mirror, encoders,
  providers minus browser branches), `clients/kamigaze/**`, and the
  `applyNetworkUpdates` path; swap points 1–6 per DESIGN §4.1.
- File-snapshot persistence + periodic checkpointing (DESIGN §3.5).
- Port-hygiene fixes (DESIGN §4.1): replay floor seeded from
  snapshot/initial block; explicit no-stream mode for gap-fill; no
  `maybeThrow`; tolerant `componentIDs.json` parse; no `mode: 'cors'`.
- Loud-fail cold start without a snapshot source (DESIGN §3.1).
- Tripwire counters: unknown componentId, decode failure, nonce bump
  (DESIGN §7).

**Gate G1** *(all [live] except e)*

- **G1.a bootstrap:** daemon reaches LIVE from an empty cache within
  a time budget; mirror holds > 10⁵ state entries. Exit code + counts.
- **G1.b mirror parity vs chain:** sample ≥ 500 `(component, entity)`
  pairs from the mirror — covering every component id present,
  Bare and full alike (direct `getValue(entity)` reads work on both;
  only reverse lookup is Bare-restricted) — and compare mirror values
  against `eth_call` reads pinned to the mirror's block. Also
  negative samples: entities the mirror holds as removed must read
  absent on-chain. Zero mismatches allowed — except rows the gate
  script itself mechanically proves Kamigaze-inherited, all three
  conditions checked per row by the script with the evidence recorded
  in the measurement: (1) absent on-chain at the pinned block,
  (2) zero events for the pair within the log-retention window,
  (3) re-served by Kamigaze on a fresh fetch. There is no
  human-waiver path. Value differences, mirror-absent/chain-present,
  and unproven mismatches always fail. (Amended 2026-07-20 by
  decision: upstream defects are excused only with mechanical proof,
  counted, and surfaced; port defects are always fatal to the gate —
  DESIGN §4.1.)
- **G1.c replay cross-validation:** take a checkpoint at block B−N
  (N ≈ 20 000, safely inside retention), RPC-replay
  `ComponentValueSet`/`ComponentValueRemoved` to B; state hash must
  equal the Kamigaze-path state at B. This is the proof that the
  event decoder and the snapshot decoder agree.
- **G1.d warm restart:** stop the daemon, restart; incremental resume
  from the checkpoint file must converge to the same state hash as a
  parallel fresh bootstrap at the same block, and time-to-LIVE must
  beat the cold path.
- **G1.e loud-fail** *(hermetic-ish)*: configured with no Kamigaze
  URL against the public RPC, the daemon must exit non-zero with the
  documented error marker — not reach LIVE over a hollow world.
- **G1.f retention re-measure:** re-run the log-retention bisection
  (design-phase measurement: ~1.02 M blocks ≈ 25 days as of
  2026-07-20); record horizon + head + date to `docs/measurements/`;
  assert a sane floor (> 100 k blocks) and flag DESIGN §4.1 for
  update if the recorded value drifts by more than 20 %.

## M2 — Projection

**Scope**

- Port `app/cache/**` (minus `app/cache/chat`, deferred) +
  `network/shapes/**` as one unit (DESIGN §3.4).
- Config readers (`is.config` entities), stats/bonus math, timestamp
  shapes.
- Clock discipline: offset-corrected `now()` from stream
  `blockTimestamp` (seconds), wired into every calc call site.

**Gate G2**

- **G2.a differential vs upstream calcs** *(hermetic)*: a test
  harness imports the calc modules from the pinned upstream clone
  directly (they are plain TS — re-verified) and runs both
  implementations over identical mirror-state snapshots for every
  kami in the mirror: `calcHealth`, `calcOutput`, `calcBounty`,
  `calcCooldown`, `calcHealTime`, liquidation thresholds. Integer
  math must match exactly; zero tolerance. Re-run on every pin
  advance (DESIGN §7).
- **G2.b live display parity** *(\[live\] + human data entry)*: with
  the official web client open beside the daemon, record into a
  fixtures file, for ≥ 10 kamis spanning states (HARVESTING, RESTING,
  on-cooldown, near-starving): displayed HP, musu output, cooldown
  remaining, state label, wall timestamp, block height. The gate
  script replays kami-lens projection at those timestamps and asserts
  agreement within display rounding (HP to the integer, cooldown to
  the second, musu to the floor). The observations are data; the
  verdict is the script's exit code. This gate presupposes an
  observer account that owns kamis in the required variety of states
  at gate time — an operational prerequisite of running the gate, not
  a dependency of kami-lens itself.
- **G2.c clock skew immunity** *(\[live\])*: run the daemon in a
  container with the system clock deliberately skewed ± 120 s;
  projected values must equal an unskewed run's at the same stream
  positions — proving projection reads corrected time, not the wall
  clock.

## M3 — Query surface: daemon, CLI, library

**Scope**

- Port `network/explorer/**`; daemon on a local socket; CLI
  `kami-lens <query> [args] → JSON`; the same queries as library
  exports.
- Stateless degraded mode (deterministic IDs + `GetterSystem` views)
  for single-kami vitals.
- Status output: sync state, block lag, effective config, tripwire
  counters, degraded/backoff state (DESIGN §3.2, §7).
- Checked-in JSON schemas for every query output.
- Untrusted-text surface (DESIGN §3.10): the response envelope
  (`{data, untrusted: [paths]}`) on every query, generated from
  (output schema × the classification artifact in docs/coverage.md);
  prose opt-in flags; the name-free mode (withhold-with-receipt,
  stable IDs).

**Gate G3** *(\[live\] except a)*

- **G3.a JSON contract** *(hermetic)*: every query's output validates
  against its checked-in schema; schema drift fails the gate.
- **G3.b node occupancy cross-check:** for a busy node, every harvest
  the mirror lists as ACTIVE is verified by direct on-chain reads of
  that harvest's `State`/`SourceID`/`IdOwnsKami` chain at the same
  block; plus negative samples (kamis reported elsewhere must not
  verify on this node). This is the discovery-query proof — the
  answer only exists via the mirror, but each element is
  chain-checkable.
- **G3.c party report parity:** own-operator report vs the official
  client's party modal, fixtures-file protocol as in G2.b (kami list,
  states, HP, cooldowns). Same prerequisite as G2.b: an observer
  account owning kamis in varied states.
- **G3.d stateless equivalence:** daemon stopped,
  `kami-lens kami <index> --stateless` must equal the daemon's answer
  for the same kami at the same block (vitals only); discovery
  queries in stateless mode must exit with the documented
  "requires daemon" code — not a wrong answer.
- **G3.e degraded-state honesty:** pointed at an unreachable Kamigaze
  URL mid-session, daemon status must report the backoff/degraded
  state within one interval; queries must still serve last-synced
  state and stamp it stale. Scripted assertions on status JSON.
- **G3.f envelope conformance** *(hermetic)*: for every query, the
  emitted `untrusted` path list must equal exactly the set derivable
  from (checked-in output schema × the per-pin string-classification
  artifact in docs/coverage.md); hand-maintained divergence fails CI.
  Also asserts name-free mode: `authored-id` values absent,
  suppression receipts present, stable IDs intact.

## M4 — Kamiden feeds

**Scope**

- Port `clients/kamiden/**` with explicit lifecycle — the upstream
  module singleton starts a perennial 5 s-retry stream as a side
  effect of the first `getClient()`; the port replaces this with
  daemon-supervised start/stop per the soft-dependency clause
  (DESIGN §3.2).
- Port the Kamiden consumers: `app/cache/chat`, `app/cache/battles`,
  `app/cache/trade` (history).
- Feed ring buffer over stream `Feed` events, served as pull queries;
  per-feed degradation surfaced in daemon status; a Kamiden outage
  never affects chain-row service or daemon liveness.
- Chat query per DESIGN §3.10: paginated `GetRoomMessages`
  passthrough; no `Messages` stream ingestion (topic filter +
  ingestion drop); oversize withhold-with-receipt; config
  kill-switch.
- The 12 served unary methods: `GetBattles`, `GetBattleStats`,
  `GetTradeHistory`, `GetOpenOffers`,
  `GetKamiMarketListings`/`GetKamiMarketBids`/`GetKamiMarketHistory`,
  `GetTokenDeposits`/`GetTokenWithdrawals`/`GetOpenWithdrawals`,
  `GetItemTransfers`, `GetAuctionBuys`.

**Gate G4**

- **G4.a unary feed conformance** *(\[live\])*: each of the 12 served
  unary methods called live → decodes → schema-valid → every entity
  ID in the response resolves against the mirror at the same block.
  Observed history depth is *recorded as a measurement, never
  asserted* — Kamiden retention is unverified, same epistemic status
  as `GetEventsSince`. Results to `docs/measurements/`.
- **G4.b stream feed cross-check** *(\[live\])*: subscribe and
  buffer; sampled `Kill` events must have mirror-resolvable
  participants and a corresponding mirror state delta within N
  blocks; `Movements` cross-checked against `RoomIndex` changes.
  Also verifies both-layer chat exclusion: subscribe with a
  Messages-excluding topic filter and assert that either no
  `Message` frames arrive or the ingestion-drop counter accounts for
  every one that does — the drop must be proven to work when the
  transport promise fails.
- **G4.c chat plan conformance** *(\[live\] + hermetic parts)*: chat
  query returns paginated `GetRoomMessages`, every body
  envelope-tagged `authored-prose`; withhold-with-receipt fires on
  an oversize fixture (hermetic); a fixture-seeded sweep of every
  non-chat query and report asserts zero message bodies anywhere in
  output (never-in-reports, checked not promised); the config
  kill-switch removes the query.

## M5 — Packaging

**Scope**

- npm package (daemon + CLI + library), baked Yominet defaults, TOML
  config + env + flags precedence, platform data dir (DESIGN §5).
- Docker image (GHCR) + compose sample, volume for data dir,
  healthcheck.
- `kami-lens --version` prints version + upstream pin.

**Gate G5** *(\[live\] where network is used)*

- **G5.a clean-room install:** `npm pack` → install the tarball in a
  fresh `node:20` container → `kami-lens daemon` with zero config
  reaches LIVE → a sample query returns schema-valid JSON. Every step
  exit-code-checked.
- **G5.b container lifecycle:** build the image; run with a mounted
  data dir; reach LIVE; restart the container; status must report an
  incremental (warm) bootstrap and beat cold time-to-LIVE;
  healthcheck goes healthy.
- **G5.c config precedence matrix:** for a config key set at all four
  levels, the effective-config block in status output must show
  flag > env > file > default, tested pairwise.
- **G5.d provenance:** LICENSE present; `package.json` license is
  AGPL-3.0; `--version` shows the `UPSTREAM` pin; ported files carry
  provenance headers (spot-checked by script).

## Order and pin advances

M0 → M1 → M2 → M3 → M4 → M5, strictly gated. A pin advance (DESIGN
§7) at any later date re-runs, at minimum: the classified diff (now
including the classification-affecting bucket, DESIGN §7), G2.a,
G2.b, G1.b, and G3.f. Coverage rows in
[docs/coverage.md](docs/coverage.md) cite the gate that verifies
them.
