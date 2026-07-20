# Coverage — per-release conformance checklist

Perception parity is defined against the pinned upstream commit
(`UPSTREAM` file; currently `ef898fc9`). This table is the release
artifact behind README principle 1: each release states, per
player-visible surface, whether kami-lens serves it — and a gap is
only ever a documented row, never an omission. Seeded from the
perception inventory in
[upstream-client-architecture.md](upstream-client-architecture.md) §5.

**Columns.** *Source* is where the data ultimately lives: `chain`
(mirrored ECS state), `code` (data shipped in the pinned client
source, e.g. room constants), `kamiden` (game-team feed service —
derived/historical, not in ECS). *Status* for the release:
`planned` (v1 target), `deferred` (explicitly postponed, with
reason), `out-of-scope` (excluded by DESIGN non-goals), `TBD`
(undecided — must be resolved before the release ships). *Gate* names
the PORT_PLAN gate that verifies the row end-to-end.

Status below reflects **v1 as designed, pre-implementation**
(2026-07-20). No release has shipped yet. All TBDs were resolved in
design session 2 (2026-07-20) — untrusted-text policy in DESIGN
§3.10, Kamiden milestone in PORT_PLAN M4.

## Fixtures (always-on HUD)

| Item | Backing state | Source | Status | Gate |
|---|---|---|---|---|
| header/clock (day/night phase) | block timestamp + phase constants | chain + code | planned | G2.b |
| menu | UI navigation chrome, no world state | — | out-of-scope | — |
| notifications | client-local derivations: quest completability, kamiden reveal events (`DTRevealerSystem`) | chain + kamiden | **deferred** — every input is served (quests G3.a, gacha/reveal G3.a, feed G4.b); the derived "alerts" digest needs its own design pass (DESIGN §6) | — |
| action queue | local tx queue (requires acting) | — | out-of-scope (read-only) | — |
| sync/loading state | `component.LoadingState` → daemon status | chain | planned | G3.e |

## Modals

| Item | Backing state | Source | Status | Gate |
|---|---|---|---|---|
| party | own kamis: calcHealth, state, cooldown, output | chain | planned | G3.c |
| kami sheet (stats/traits/skills/equipment) | `shapes/Kami/*`, `shapes/Skill` | chain | planned | G2.a, G2.b |
| kami sheet: battles tab | kamiden `GetBattles` + `GetBattleStats` | kamiden | planned | G4.a |
| node (occupants, ally/enemy threat, scavenge) | `shapes/Node/harvests` mirror query, liquidation calcs, `shapes/Scavenge` | chain | planned | G3.b |
| map | `shapes/Room`, `shapes/Portal`, room constants | chain + code | planned | G3.a |
| inventory | `shapes/Inventory` | chain | planned | G3.a |
| inventory: transfer-history tab | kamiden `GetItemTransfers` | kamiden | planned | G4.a |
| chat | kamiden `GetRoomMessages` — dedicated opt-in query; no stream ingestion (topic filter + ingestion drop); oversize withhold-with-receipt; config kill-switch (DESIGN §3.10) | kamiden | planned | G4.c |
| crafting | `shapes/Recipe` | chain | planned | G3.a |
| merchant | `shapes/Npc`, `shapes/Listing` | chain | planned | G3.a |
| marketplace (KamiSwap) | kamiden `GetKamiMarketListings/Bids/History` + `shapes/Listing` | chain + kamiden | planned | G3.a + G4.a |
| trading | `shapes/Trade` + kamiden `GetTradeHistory`/`GetOpenOffers` | chain + kamiden | planned | G3.a + G4.a |
| quests | `shapes/Quest` + `shapes/Conditional` evaluation | chain | planned | G3.a |
| goal | `shapes/Goals` | chain | planned | G3.a |
| leaderboard | `shapes/Score` + `constants/leaderboards` (kamiden ranking RPCs exist but are ApiKey-gated and uncalled by the client at this pin) | chain + code | planned | G3.a |
| gacha / reveal (incl. the `lootBox` droptable-reveal UI — no component of its own) | `shapes/Gacha`, `shapes/Commit` (block-driven commit-reveal) | chain | planned | G3.a |
| gacha: auction price chart | kamiden `GetAuctionBuys` | kamiden | planned | G4.a |
| account | `shapes/Account` (stamina, room, friends, reputation) | chain | planned | G3.a |
| bridges: wallet flows (`bridge`, `bridgeERC20`, `bridgeERC721`) | wagmi/Initia wallet operations (requires acting) | — | out-of-scope (read-only) | — |
| bridges: deposit/withdrawal history | kamiden `GetTokenDeposits`/`GetTokenWithdrawals`/`GetOpenWithdrawals` | kamiden | planned | G4.a |
| dialogue / questDialogue | code-shipped dialogue trees + `shapes/Quest`/room state | chain + code | planned | G3.a |
| operator gas balance | `eth_getBalance(operator)` (shown by FundOperator/header) | chain | planned | G3.a |
| acting flows: kamiSend, naming (incl. its emaBoard UI), kamiPortal, kamiAdoptionAgency, operatorFund, templeOfTheWheel, obol, presale | acting UIs; their read-side state is served by general queries over the ported `app/cache`/shapes (account, kami, item, config, listings) | — | out-of-scope (read-only) | — |
| studio, help, settings | chrome; no world state (shader viewer, static copy, local prefs — verified by import audit) | — | out-of-scope | — |

## Not modal-bound but player-visible

| Item | Backing state | Source | Status | Gate |
|---|---|---|---|---|
| battle/kill feed | kamiden stream `Feed`, daemon ring buffer served as pull query | kamiden | planned | G4.b |
| room presence (other accounts) | `RoomIndex == here` mirror query | chain | planned | G3.b |

## Standing caveats

- Player-authored strings, measured at the pin: account and kami
  names (≤16 bytes, unique, non-empty), account bio (≤140 bytes of
  free text — surfaced by `shapes/Account` friend/request/blocked
  cards inside planned rows), chat messages (no on-chain length cap;
  the web client's 200-char limit is send-side input validation
  only). Kamiden payloads otherwise carry no player-authored text:
  feed/trade/market/portal messages are IDs, indices, and amounts;
  names render via consumer-side joins against the mirror's `Name`
  component.
- Taint model (settled, design session 2; DESIGN §3.10): every
  string that can reach output is classified per pin — see the
  classification table below. Classification changes on a pin
  advance get the same hand-review class as formula-affecting diffs
  (DESIGN §7).

## String classification (per-pin artifact — DESIGN §3.10)

Fail-safe default: **any string field not listed here is
`authored-prose`** (never volunteered). Gate G3.f asserts every
query's envelope against this table; changes to this table get
formula-class hand review (DESIGN §7).

| Class | Fields at this pin |
|---|---|
| `authored-id` | kami `Name`, account `Name` (≤16 bytes, unique, non-empty; **no charset restriction**) — inline by default, always envelope-tagged, withheld in name-free mode |
| `authored-prose` | account bio (≤140 bytes); chat `Message.Message` (unbounded) — never volunteered; opt-in only |
| `registry` | item/quest/skill/goal/room/node names & descriptions, NPC dialogue trees, `constants/**` display text (incl. `constants/leaderboards` titles) |
| `system` | addresses, entity/order/commit IDs, enum & state labels, `MediaURI` values, numeric amounts serialized as proto strings |

Known but unserved: kamiden `RankRow.KamiName`/`OwnerName` and
`LeaderboardRow.Name` (`authored-id`; their RPCs are ApiKey-gated or
uncalled and kami-lens does not serve them).
- `code`-sourced rows change only via a pin advance and are diffed by
  the tracking protocol's coverage-affecting bucket (DESIGN §7).

## Maintenance

Per release: resolve every `TBD` to `planned`/`deferred`/
`out-of-scope`; flip `planned` to a gate reference once its gate
passes; on a pin advance, add rows for any new modal/fixture found by
the classified diff — served or explicitly deferred, never silent.
