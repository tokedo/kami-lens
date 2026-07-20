# kami-lens — Design

Status: **v1 — settled** (2026-07-20; untrusted-text policy §3.10 and
Kamiden scope settled in design session 2, same date). Evidence base:
[docs/upstream-client-architecture.md](docs/upstream-client-architecture.md)
(study of the official client at upstream commit `ef898fc9`),
re-verified claim-by-claim against a fresh clone on 2026-07-20 (see
the study's errata section), plus live measurements against the
public Yominet RPC taken the same day (§4.1).

## 1. Goals

- Give any headless consumer (agent, bot, terminal user) the same
  perception of the Kamigotchi world the official web client gives a
  player: last known on-chain state plus live projected values.
- Run entirely on the user's own machine; be installable by anyone.
- Answer discovery queries the chain cannot: node occupancy, room
  presence, market browsing — these require a synced local mirror
  (64 of 95 components are `BareComponent`: no on-chain reverse
  lookup).

## 2. Non-goals

- **Acting.** kami-lens is read-only; it never signs or submits
  transactions.
- **History and analytics.** Anything beyond what the web client
  shows a player in-session is out of scope.
- **A hosted service.** No central deployment, no API keys, no
  accounts.

## 3. Settled decisions

### 3.1 Sync — same as the web client, stated precisely

- Kamigaze snapshot (`GetStateBlock` → `GetComponents` →
  `GetState(removals)` → `GetState(values)` → `GetEntities`,
  incremental from the cached block; a nonce mismatch forces a full
  reload) is the bootstrap path — and a **hard dependency for cold
  start**.
- Kamigaze `SubscribeToStream` for push; gaps healed by
  `GetEventsSince`, with RPC `eth_getLogs` replay as fallback.
- Pure-RPC event replay (`ComponentValueSet` /
  `ComponentValueRemoved` World logs) is used exactly where the web
  client uses it: gap-fill over recent blocks, and dev/local chains.
  It is **not** a production bootstrap path: the public RPC retains
  logs only for a trailing window (§4.1), so replay from the world
  deploy block is impossible there. The web client never faces this
  because its production config always sets the Kamigaze URL; its
  no-snapshot code path is exercised only against short local dev
  chains, where replay-from-genesis is cheap and complete.
- One deliberate divergence: upstream, configured without a snapshot
  source against a pruned RPC, would silently replay empty ranges
  and report LIVE over an incomplete world. kami-lens refuses to
  cold-start without a snapshot source (or an RPC whose log history
  covers the world's full span — a dev chain or a user-run archive
  node) and reports why. Fail loudly, never lie.

### 3.2 Rate limits — same as the web client

Kamigaze rate-limiting (gRPC code 8, or HTTP 403 from the health
endpoint) fails the bootstrap attempt; upstream shows the player an
error and the player reloads. The daemon equivalent: bounded
backoff-retry, with the degraded state surfaced in status output. No
bespoke degradation machinery. RPC fallback serves exactly the roles
it has upstream — gap-fill and stream outage — and only within the
retention horizon.

**Kamiden is a soft dependency** (settled, design session 2). A
Kamiden outage or rate-limit degrades exactly the `kamiden`-sourced
coverage rows, surfaced per-feed in daemon status; chain-row service
and daemon liveness are never coupled to it. The upstream client's
Kamiden singleton starts a perennial 5 s-retry stream as an import
side effect — the port replaces that with explicit lifecycle under
daemon supervision. If Kamiden access tightens before M4 ships (the
ApiKey-gated ranking methods prove the operators fence endpoints),
the affected rows flip to `deferred (service access)` in coverage —
visibly, never silently.

### 3.3 Projection ported, not re-derived

Lift the client's calc layer (`calcHealth`, `calcBounty`,
`calcOutput`, `calcCooldown`, `calcHealTime`, liquidation math) and
shapes as-is. Constants come from on-chain `is.config` entities —
verified bit-identical between the client reader and `LibConfig`
(same `keccak256(abi.encodePacked('is.config', field))` entity ID,
same 8×uint32 unpack order) — so balance patches that only change
config values require no kami-lens change. Exceptions ship in client
code, with the pin: e.g. the map's room data (`constants/rooms`) and
the hardcoded 180 s cooldown fallback. These are tracked per release
in [docs/coverage.md](docs/coverage.md) with source `code`, and
changes to them are caught by the tracking protocol (§7).

### 3.4 The port preserves upstream structure — including its tangles

`network/shapes` and `app/cache` import each other; `network/explorer`
reaches into `app/cache`. The port keeps this: projection =
`network/shapes` + `app/cache` ported **as one unit**, with their real
dependencies (`recs`, lodash, ethers,
`@stdlib/stats-base-dists-normal-cdf`, `constants/**`) — not the
"recs + lodash only" of earlier drafts. `app/cache/chat` (a Kamiden
consumer living inside the projection layer) ports in milestone M4
with the rest of the Kamiden client, under the untrusted-text policy
(§3.10).
Restructuring upstream code is how silent formula drift happens; we
don't.

### 3.5 State cache — file snapshot, periodically checkpointed

Upstream persists the whole `StateCache` wholesale into IndexedDB
(8 object stores), loads once at boot, saves exactly once after
backfill — a per-page-load pattern. The port keeps the wholesale
model and swaps the store for a **single-file binary snapshot**:

- `v8.serialize` of the `StateCache` (structured-clone semantics —
  handles the internal `Map`s natively, closest analogue of the
  IndexedDB write).
- Write to temp file, fsync, atomic rename; keep one previous
  generation.
- Checkpoint after bootstrap (as upstream does), on a configurable
  interval (default 10 min — the daemon's equivalent of the
  browser's natural reload cycle), and on clean shutdown.
- Header: `{chainId, worldAddress, cacheVersion, kamigazeNonce,
  blockNumber}`; any mismatch → discard and re-bootstrap.

The cache is **disposable by design** (a Kamigaze nonce change
already forces full reload upstream), which is what makes this choice
cheap to revise. SQLite (`node:sqlite`) is the named upgrade if
checkpoint cost bites (§6); `v8.serialize`'s Node-version coupling is
acceptable for a disposable cache.

### 3.6 Interface: on-demand pull, JSON out

No ambient push. The lens never alters what the world contains; it
only chooses what it volunteers (§3.10). Query tools are general (any operator/account/node
as argument). Consumers that want a session-start briefing simply run
the own-operator report themselves — it is the same general tool, not
a special path.

### 3.7 History boundary: web-client parity

Kamiden in-session feeds (kill feed, recent trades, market history)
are inside the target; longitudinal reconstruction is not. The chat
pane is inside the target, served under the untrusted-text policy
(§3.10).

### 3.8 Clock discipline

Projection uses stream `blockTimestamp` offset-correction, not naive
wall clock (the web client uses `Date.now()`; a daemon must not
assume a synced clock). Unit care: stream `blockTimestamp` is uint32
**seconds**; Kamiden timestamps are **milliseconds**.

### 3.9 License: AGPL-3.0

Upstream is AGPL-3.0; this is a derivative work.

### 3.10 Untrusted text — taint model, envelope, composition

Settled in design session 2 (2026-07-20), superseding the v1 chat
deferral. Verified basis (study errata, second pass): the complete
player-authored string surface at the pin is account/kami names
(≤16 bytes, unique, non-empty, **no charset restriction**), account
bio (≤140 bytes), and chat (no on-chain length cap); Kamiden payloads
otherwise carry no player text — names render via mirror joins.

- **Taint model.** Every string that can reach output is classified
  per pin in [docs/coverage.md](docs/coverage.md): `authored-id`
  (bounded unique handles: kami and account names) / `authored-prose`
  (free text: bio, chat) / `registry` (game-content text shipped in
  registries or pinned code) / `system` (addresses, IDs, enums). The
  id/prose split is a flagged amendment to the original three-way
  model. Fail-safe default: an unclassified string is treated as
  `authored-prose` — the strictest class; new upstream fields arrive
  untrusted until classified, and classification changes get
  formula-class hand review (§7).
- **Envelope delivery.** Every response is
  `{data, untrusted: [<paths>]}` — values verbatim, paths of
  authored-class strings listed, empty list when none. The list is
  generated from (output schema × classification artifact), never
  hand-maintained; gate G3.f fails CI on divergence. Envelope over
  in-band wrapping, recorded rationale: the fail-safe default makes
  reclassification routine, and in-band tags would turn every
  reclassification into a breaking shape change — volatile-by-design
  metadata must not live inside the data shapes. Envelope over
  docs-only: opt-in surfaces must return authored text *tagged*,
  machine-actionably.
- **Composition.** `authored-prose` is never volunteered: absent from
  every default output, report, and aggregate; bio behind an explicit
  opt-in flag on the general queries; chat behind a dedicated query.
  `authored-id` (names) is **inline by default, always tagged**,
  bounded by parity: names appear only where the web client shows
  names, never in novel aggregations. A first-class name-free mode
  (`--no-authored` / config) withholds authored-id values with
  receipt — field absent, suppression noted, stable IDs kept for
  joins. Decision record, both positions: opt-in names (agents are
  the median consumer; account names are a cheap swarm vector —
  [docs/threat-model.md](docs/threat-model.md)) was argued and
  rejected because default parity for names is what the screen
  actually shows by default — unlike bio, which the screen shows only
  on demand; the cautious consumer is served by the tag, the
  name-free mode, and the threat model.
- **No mutation, ever.** Values are verbatim or absent-with-receipt:
  an oversize chat message is omitted with an explicit receipt and a
  raw-fetch override, never truncated or rewritten. Nothing altered,
  nothing silently dropped.
- **Chat plan** (resolves the deferral; gate G4.c): dedicated
  paginated `GetRoomMessages` query; no `Messages` stream ingestion —
  excluded at the topic filter **and** dropped at ingestion
  (transport promises are not trusted alone); oversize
  withhold-with-receipt; config kill-switch; never in reports.
- Threat model: [docs/threat-model.md](docs/threat-model.md). Its
  headline: tagging does not make injection safe; a consumer that
  feeds authored text to an LLM context does so knowingly.

## 4. Architecture

### 4.1 Sync layer

Port of the upstream `SyncWorker` (plain TS + rxjs). Browser-bound
swap points (re-verified exhaustive, with amendments):

1. env config — `import.meta.env` is read in
   `network/setup/configs/configs.ts` **and** `clients/kamigaze/client.ts`,
   `clients/kamiden/client.ts`, `clients/kamiden/txErrorLogger.ts`
   (→ process env / config file, §5)
2. web-worker wrapper (→ in-process or `worker_threads`)
3. IndexedDB state cache, 8 object stores (→ file snapshot, §3.5)
4. gRPC-web browser transport (→ Node transport; protos are already
   nice-grpc definitions)
5. tab-visibility wake signals (→ delete)
6. vendored `recs` `Component.ts`: one React hook **plus dead
   localStorage local-cache helpers** (→ strip both)
7. Vite path aliases (→ tsconfig/tsup)

Port hygiene — upstream artifacts **not** to lift as-is:

- The worker never reads `config.initialBlockNumber`; a fresh cache
  gap-fills from block 0. The port seeds the replay floor from the
  snapshot state or the configured initial block.
- In no-stream mode `fillGap` receives an undefined Kamigaze URL and
  only works via its error path — the port passes an explicit mode.
- `workers/sync/snapshot/fetch.ts` contains a dead test helper
  (`maybeThrow`, throws with probability 0.6) — do not lift.
- `componentIDs.json` is not strict JSON (trailing comma).
- The snapshot health check uses browser-only fetch `mode: 'cors'`.
- Upstream persists the state cache exactly once per session; the
  daemon adds periodic checkpointing (§3.5).
- **Undecodable state rows** (decision, 2026-07-20 implementation
  session): upstream aborts the whole sync attempt when any
  snapshot/stream/gap-fill row fails component-value decode — bounded
  retries, then a dead client. (Measured that day live: two Kamigaze
  indexer ghost rows — array-schema components carrying single-word
  payloads, absent on-chain — bricked every fresh client load.) The
  port instead skips the row, increments the `decodeFailures`
  tripwire (§7), logs component/entity/bytes, and surfaces degraded
  status. Unifying principle for this divergence and the gate G1.b
  excusal amendment (PORT_PLAN): **the lens is faithful to the web
  client's view; upstream defects are excused only with mechanical
  proof, counted, and surfaced; port defects are always fatal to the
  gate.**

Measured RPC constraints (public Yominet endpoint, 2026-07-20):

| Fact | Value |
|---|---|
| head block | ~31.15 M |
| average block time (trailing month) | ~2.1 s |
| World-contract log density (recent) | ~15–17 logs/block |
| `eth_getLogs` range cap | 1,000,000 blocks |
| `eth_getLogs` cost at recent density | ~23 s per 10 k-block range |
| log retention | trailing ~1.02 M blocks ≈ 25 days |
| behavior beyond retention | empty result, HTTP 200 — not an error |

Consequences: RPC gap-fill of a one-day outage (~41 k blocks) costs
roughly two minutes in 10 k-block chunks; an outage beyond the
retention window cannot be healed from RPC at all — it takes Kamigaze
`GetEventsSince` (its own retention: unverified) or a full
re-snapshot. Because pruned ranges return empty success, the sync
layer treats "empty result from an old range" as suspect, never as
proof of no events. The retention window is remeasured as a
PORT_PLAN gate.

### 4.2 Projection layer

Direct port of upstream `app/cache/**` calcs + `network/shapes/**`
readers, as one unit (§3.4). Config, stats, bonuses, and timestamps
all come from mirrored on-chain components; in-code constants ship
with the pin (§3.3).

### 4.3 Query surface

Seeded from upstream `network/explorer/` (a ready-made read API over
the mirror: accounts, kamis, nodes, items, quests, trades, auctions,
configs). Exposed as:

- **daemon** — long-running process holding the mirror, local socket
- **CLI** — `kami-lens <query> [args] → JSON` against the daemon,
  with a degraded stateless mode (deterministic entity IDs +
  `GetterSystem` view calls) for single-kami vitals when no daemon
  is running
- **library** — the same queries importable in-process

The surface additionally serves the Kamiden feeds (battles, trade
history, KamiSwap, portal history, feed buffer, chat) per §3.7 and
§3.10; every response — CLI, socket, or library — carries the §3.10
envelope.

### 4.4 Coverage checklist

The perception inventory (every web-client fixture/modal and the
state behind it) is enumerated in
[docs/upstream-client-architecture.md](docs/upstream-client-architecture.md)
§5 and tracked per release in [docs/coverage.md](docs/coverage.md):
one row per item, with backing state, source (`chain` / `code` /
`kamiden`), and status (`served` / `deferred` / `out-of-scope`).
Never silent gaps.

## 5. Packaging & configuration

- **npm package first**: one package containing daemon, CLI, and
  library exports (`npx kami-lens …`, `npm i -g`, or
  `import 'kami-lens'`). Node ≥ 20.
- **Docker image second** (GHCR, built from the same package, volume
  for the data dir, sample compose file) for supervised always-on
  daemons.
- **Zero-config by default**: baked defaults are the production
  Yominet values from the upstream README — chain id
  `428962654539583`, world `0x2729174c265dbBd8416C6449E0E813E88f43D0E7`,
  initial block `44577`, the public Initia RPC/WSS endpoints, and
  `https://api.prod.kamigotchi.io`. `kami-lens daemon` works with no
  config file.
- **Config precedence**: CLI flags > env vars (`KAMI_LENS_*`) > TOML
  file (`~/.config/kami-lens/config.toml` or platform equivalent) >
  baked defaults. Keys: chain id, world address, RPC/WSS URLs,
  Kamigaze URL, data dir, checkpoint interval, optional default
  operator (a convenience prefill for the general operator-argument
  tools — never a special path).
- **Data dir**: platform data directory, cache files keyed
  `{chainId}-{worldAddress}` (mirroring upstream's
  `ECSCache-<chainId>-<worldAddress>-v5` IndexedDB naming).

## 6. Deferred — documented, not silent

- **Notifications digest ("alerts" query).** The web client's
  notification toasts derive entirely from served state (quest
  completability, reveal events); a pull-style digest of "what needs
  attention" is deferred — its trigger/threshold parity deserves its
  own design pass, not a v1 tail. Coverage row `notifications` is
  marked deferred. (The former chat deferral is resolved by §3.10;
  chat is planned for v1.)
- **SQLite persistence.** Upgrade trigger: sustained checkpoint cost
  (serialize > ~2 s, or observable daemon stalls).
- **Differential oracle testing** — vendoring the pinned upstream
  calc modules and diffing outputs against the port over identical
  mirror state (strongest formula-drift detection; §7 names the
  upgrade path). A gate-time variant of this already exists as
  PORT_PLAN gate G2.a, run from a fresh clone of the pin on every
  pin advance; what is deferred is only the continuous,
  vendored-in-repo variant maintained as standing test
  infrastructure.
- **Single-binary packaging.**

## 7. Upstream tracking protocol

- **The pin is a file**: `UPSTREAM` at the repo root (commit hash +
  date). Every kami-lens release names exactly one pin;
  docs/coverage.md is per-pin.
- **Advancing the pin is a scripted, classified diff** of watched
  paths between old and candidate pin:
  - *formula-affecting*: `packages/client/src/app/cache/**`,
    `packages/contracts/src/libraries/**` — hand review mandatory;
  - *classification-affecting*: the player-string write paths
    (`ChatSystem`, `AccountRegisterSystem`, `AccountSetNameSystem`,
    `AccountSetBioSystem`, `KamiNameSystem`, `KamiOnyxRenameSystem`)
    and `clients/kamiden/proto.ts` string fields — any change to the
    string-classification artifact in docs/coverage.md gets the same
    mandatory hand review as formula-affecting diffs (§3.10; the
    guard against rubber-stamp reclassification);
  - *state-affecting*: `packages/contracts/src/{components,systems}/**`,
    `deploy.json`, `componentIDs.json` — new components become
    coverage rows, mapped or explicitly ignored;
  - *sync-affecting*: `packages/client/src/{workers,clients,engine}/**`;
  - *coverage-affecting*:
    `packages/client/src/app/components/{modals,fixtures}/**`,
    `app/stores/visibility.ts` — new player-visible surface becomes a
    checklist row, served or explicitly deferred.
- **Empirical confirmation over diff-reading**: the pin advances only
  after the PORT_PLAN parity gates re-pass against the live game
  (projected values vs the official client at the same block). The
  diff says where to look; the gate says we got it right.
- **Runtime tripwires between pins**: a stream event with a
  `componentId` missing from the registry, component-value decode
  failures, and Kamigaze nonce bumps are each counted and surfaced in
  daemon status — contract-side drift announces itself even if no one
  has diffed the repo. Never silent.
