# kami-lens — Design (draft)

Status: **draft under review** — settled decisions are marked ✅;
open items are listed at the end. Evidence base:
[docs/upstream-client-architecture.md](docs/upstream-client-architecture.md)
(study of the official client at upstream commit `ef898fc9`).

## 1. Goals

- Give any headless consumer (agent, bot, terminal user) the same
  perception of the Kamigotchi world the official web client gives a
  player: last known on-chain state plus live projected values.
- Run entirely on the user's own machine; be installable by anyone.
- Answer discovery queries the chain cannot: node occupancy, room
  presence, market browsing — these require a synced local mirror
  (~65 of 95 components are `BareComponent`: no on-chain reverse
  lookup).

## 2. Non-goals

- **Acting.** kami-lens is read-only; it never signs or submits
  transactions.
- **History and analytics.** Anything beyond what the web client
  shows a player in-session is out of scope.
- **A hosted service.** No central deployment, no API keys, no
  accounts.

## 3. Settled decisions

- ✅ **Sync strategy — same as the web client.** Kamigaze snapshot
  (`GetStateBlock` → `GetComponents` → `GetState` → `GetEntities`,
  incremental from cached block) for bootstrap; Kamigaze
  `SubscribeToStream` for push; gap-fill via `GetEventsSince` with
  RPC `eth_getLogs` fallback; full pure-RPC mode as sovereign
  fallback (event replay from the world deploy block). Use game-team
  services exactly insofar as the web client uses them.
- ✅ **Projection ported, not re-derived.** Lift the client's calc
  layer (`calcHealth`, `calcBounty`, `calcOutput`, `calcCooldown`,
  `calcHealTime`, liquidation math) and shapes; all constants read
  from on-chain `is.config` entities. Pin the upstream commit; the
  coverage claim is defined against that pin.
- ✅ **Interface: on-demand pull, JSON out.** No ambient push. Query
  tools are general (any operator/account/node as argument).
  Consumers that want a session-start briefing simply run the
  own-operator report themselves — it is the same general tool, not
  a special path.
- ✅ **History boundary: web-client parity.** Kamiden in-session
  feeds (chat, kills, recent trades) are inside; longitudinal
  reconstruction is not.
- ✅ **Clock discipline.** Projection uses stream `blockTimestamp`
  offset-correction, not naive wall clock (the web client uses
  `Date.now()`; a daemon must not assume a synced VM clock).
- ✅ **License: AGPL-3.0** (upstream is AGPL-3.0; this is a
  derivative work).

## 4. Architecture

### 4.1 Sync layer

Port of the upstream `SyncWorker` (plain TS + rxjs). Known
browser-bound swap points (exhaustive, from the upstream study):

1. env config (`import.meta.env` → process env)
2. web-worker wrapper (→ in-process or `worker_threads`)
3. IndexedDB state cache (→ SQLite or file snapshot)
4. gRPC-web browser transport (→ Node transport / nice-grpc)
5. tab-visibility wake signals (→ delete)
6. one React hook in the vendored `recs` (→ strip)
7. Vite path aliases (→ tsconfig/tsup)

Everything else — snapshot fetch, stream, gap-fill, event decode,
`recs` ECS mirror, indexer — lifts as-is.

### 4.2 Projection layer

Direct port of upstream `app/cache/**` calcs + `network/shapes/**`
readers (dependencies: `recs` + lodash only). Config, stats, bonuses,
and timestamps all come from mirrored on-chain components.

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

### 4.4 Coverage checklist

The perception inventory (every web-client fixture/modal and the
state behind it) is enumerated in
[docs/upstream-client-architecture.md](docs/upstream-client-architecture.md)
§5. Each release documents which checklist items it serves and which
it does not. Never silent gaps.

## 5. Open items

- Finalize the coverage checklist into a tracked, per-release
  conformance table.
- Persistence choice for the state cache (SQLite vs file snapshot of
  `StateCache`) and initial-backfill benchmarks for pure-RPC mode.
- Daemon packaging: docker image, init/install story, config file
  format (chain, world address, endpoints, operator defaults).
- Rate-limit behavior against Kamigaze/Kamiden (the services are
  public but rate-limited; back-off must degrade to RPC gracefully).
- Upstream tracking protocol: how new upstream releases are diffed,
  formula changes detected, and the pin advanced.
- Chat *send* is out of scope for kami-lens (read-only); confirm the
  read side (`GetRoomMessages` + stream) fully covers the chat pane.
