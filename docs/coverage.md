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
(2026-07-20). No release has shipped yet.

## Fixtures (always-on HUD)

| Item | Backing state | Source | Status | Gate |
|---|---|---|---|---|
| header/clock (day/night phase) | block timestamp + phase constants | chain + code | planned | G2.b |
| menu | UI navigation chrome, no world state | — | out-of-scope | — |
| notifications | local derivations of synced state | chain | TBD | — |
| action queue | local tx queue (requires acting) | — | out-of-scope (read-only) | — |
| sync/loading state | `component.LoadingState` → daemon status | chain | planned | G3.e |

## Modals

| Item | Backing state | Source | Status | Gate |
|---|---|---|---|---|
| party | own kamis: calcHealth, state, cooldown, output | chain | planned | G3.c |
| kami sheet (stats/traits/skills/equipment) | `shapes/Kami/*`, `shapes/Skill` | chain | planned | G2.a, G2.b |
| kami sheet: battles tab | kamiden `GetBattles` | kamiden | TBD | — |
| node (occupants, ally/enemy threat, scavenge) | `shapes/Node/harvests` mirror query, liquidation calcs, `shapes/Scavenge` | chain | planned | G3.b |
| map | `shapes/Room`, `shapes/Portal`, room constants | chain + code | planned | G3.a |
| inventory | `shapes/Inventory` | chain | planned | G3.a |
| chat | kamiden `GetRoomMessages` + stream | kamiden | **deferred** — player-authored text needs its own plan (untrusted input / prompt injection) before being fed to agent consumers; see DESIGN §6 | — |
| crafting | `shapes/Recipe` | chain | planned | G3.a |
| merchant | `shapes/Npc`, `shapes/Listing` | chain | planned | G3.a |
| marketplace (KamiSwap) | kamiden market listings/bids/history + `shapes/Listing` | chain + kamiden | TBD | — |
| trading | `shapes/Trade` + kamiden trade history/open offers | chain + kamiden | TBD | — |
| quests | `shapes/Quest` + `shapes/Conditional` evaluation | chain | planned | G3.a |
| goal | `shapes/Goals` | chain | planned | G3.a |
| leaderboard | `shapes/Score` + kamiden rankings | chain + kamiden | TBD | — |
| gacha / reveal | `shapes/Gacha`, `shapes/Commit` (block-driven commit-reveal) | chain | planned | G3.a |
| account | `shapes/Account` (stamina, room, friends, reputation) | chain | planned | G3.a |
| bridges: wallet flows | wagmi/Initia wallet operations (requires acting) | — | out-of-scope (read-only) | — |
| bridges: deposit/withdrawal history | kamiden `GetTokenDeposits/Withdrawals` | kamiden | TBD | — |
| misc (kamiSend, naming, temple, lootBox, dialogue, …) | transfer/naming/sacrifice shapes, NPC dialogue | chain + code | TBD | — |

## Not modal-bound but player-visible

| Item | Backing state | Source | Status | Gate |
|---|---|---|---|---|
| battle/kill feed | kamiden stream `Feed` | kamiden | TBD | — |
| room presence (other accounts) | `RoomIndex == here` mirror query | chain | planned | G3.b |

## Standing caveats

- Player-authored strings (kami names, account names) appear in many
  served rows; they are untrusted input wherever surfaced (DESIGN §6).
- `code`-sourced rows change only via a pin advance and are diffed by
  the tracking protocol's coverage-affecting bucket (DESIGN §7).

## Maintenance

Per release: resolve every `TBD` to `planned`/`deferred`/
`out-of-scope`; flip `planned` to a gate reference once its gate
passes; on a pin advance, add rows for any new modal/fixture found by
the classified diff — served or explicitly deferred, never silent.
