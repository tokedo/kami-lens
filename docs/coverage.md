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
`served (<gate>)` (in the release and verified end-to-end by that
gate), `not served` (in scope, no query at this version — never a
silent gap), `planned` (a target of a later version), `deferred`
(explicitly postponed, with reason), `out-of-scope` (excluded by
DESIGN non-goals), `TBD` (undecided — must be resolved before the
release ships). *Gate* names the PORT_PLAN gate that verifies the row
end-to-end.

Status below reflects **0.2.0** (2026-07-22): implemented, with gates
G0–G6 green against the pinned upstream commit and the live game
(dated evidence in `docs/measurements/`). The release act itself is
held — nothing published to npm or a container registry yet. No `TBD`
remains; the last were resolved in design session 2 (2026-07-20) —
untrusted-text policy in DESIGN §3.10, Kamiden milestone in PORT_PLAN
M4.

Per the Maintenance rule below, a row reads `served (<gate>)` once the
gate that verifies it end-to-end has passed. Five rows are **not**
served at 0.2.0 and say so instead of carrying a gate they do not
have — crafting, goal, gacha/reveal, dialogue/questDialogue, and
operator gas balance: their upstream shapes are ported into the mirror
but no query reaches them, so no gate does either (G3.a iterates the
served query set only). A sixth, map, is served in part — room
identity and occupancy, not the exit/portal graph. Named here rather
than left as an implied `planned`.

## Fixtures (always-on HUD)

| Item | Backing state | Source | Status | Gate |
|---|---|---|---|---|
| header/clock (day/night phase) | block timestamp + phase constants | chain + code | served (G2.b, G6.a) | G2.b; the dedicated `phase` query (0.2.0) adds G6.a + `test/phase.test.ts` |
| menu | UI navigation chrome, no world state | — | out-of-scope | — |
| notifications | client-local derivations: quest completability, kamiden reveal events (`DTRevealerSystem`) | chain + kamiden | **deferred** — the served inputs are quests (G3.a) and feed (G4.b); the reveal input is itself unserved (see the gacha/reveal row), and the derived "alerts" digest needs its own design pass (DESIGN §6) | — |
| action queue | local tx queue (requires acting) | — | out-of-scope (read-only) | — |
| sync/loading state | `component.LoadingState` → daemon status | chain | served (G3.e) | G3.e |

## Modals

| Item | Backing state | Source | Status | Gate |
|---|---|---|---|---|
| party | own kamis: calcHealth, state, cooldown, output | chain | served (G3.c) | G3.c |
| kami sheet: level / experience / skill points | `shapes/Kami/progress`, `shapes/Kami/skills`, `shapes/Skill` | chain | served (0.5.0) — `kami`/`party`/node occupant rows carry level, `xp`, `xpRequired`, `levelUpReady` (+ `levelUpBlockedBy`) and unspent `skillPoints`; the `skills` query carries the registry and a kami's taken skills with ranks | G3.a, G3.f, G6.a, G7.a |
| kami sheet: STATS + affinities | `shapes/Kami/stats`, `shapes/Stats`, `app/cache/kami/functions` (affinity pair) | chain | served (0.5.1) — the `--stats` flag on `kami`, `roster`, `party` and `node --with-vitals` serves `base`/`shift`/`boost`/`sync`/`total` for health, power, harmony and violence, plus `[body, hand]` affinities. Opt-in: without the flag every 0.5.0 answer is byte-identical. `slots` and `stamina` are NOT served here — they are in the mirror but not in the chain getter's tuple, so no gate could hold them to chain. | G2.d, G3.a, G3.f, G3.g, G7.a |
| kami sheet: traits | `shapes/Kami/traits`, `shapes/Trait` | chain | **not served** — **deferred with a reason at 0.5.1, docketed.** The mirror holds them and refreshes them on every kami read, so this is a projection decision, not an absence. The chain-checkable form is trait INDICES, measured at +66 B/kami: on a 150-kami `roster --stats` that is 94 % of the 64 KiB reader budget spent on identifiers nothing on the surface can resolve, because there is no trait-registry query to join them against. Serve the registry first, then the indices. | — |
| kami sheet: equipment | `app/cache/equipment` | chain | **not served** — unchanged from 0.5.0 and still docketed. (This row and the two above were ONE row until 0.5.1, carrying a single status for three different surfaces; 0.5.0 had already corrected that row for borrowing G2.a/G2.b, gates that verify the ported calcs' *computation* parity and reach no query output. Splitting it is the same rule applied one level down: a row states the status of one thing.) | — |
| kami sheet: battles tab | kamiden `GetBattles` + `GetBattleStats` | kamiden | served (G4.a) | G4.a |
| node (occupants, ally/enemy threat, scavenge) | `shapes/Node/harvests` mirror query, liquidation calcs, `shapes/Scavenge` | chain | served (G3.b) | G3.b |
| map | `shapes/Room` (identity, description, location, exits, gates), `shapes/Portal` | chain | served **in part** (G3.a, G6.b) — the `room` query serves room identity, occupancy and, from 0.5.0, the EXIT graph with the conditions stored on each exit. The portal half is still unserved, and the room's map COORDINATE is docketed, not built. *(The 0.2.0 row named "room constants" as a source; `constants/rooms` was never ported — room data comes from the mirror's own components. Corrected at 0.5.0.)* | G3.a; the `room` query (0.2.0) adds G6.b; exits fold into G6.b at 0.5.0 |
| inventory | `shapes/Inventory` | chain | served (G3.a, G6.a, G6.b) | G3.a; dedicated any-account `inventory` query (0.2.0): G6.a + G6.b |
| inventory: transfer-history tab | kamiden `GetItemTransfers` | kamiden | served (G4.a) | G4.a |
| chat | kamiden `GetRoomMessages` — dedicated opt-in query; no stream ingestion (topic filter + ingestion drop); oversize withhold-with-receipt; config kill-switch (DESIGN §3.10) | kamiden | served (G4.c) | G4.c |
| crafting | `shapes/Recipe` | chain | **not served at 0.2.0** — shapes ported, mirror-only, no dedicated query | — |
| merchant | `shapes/Npc`, `shapes/Listing` | chain | served (G3.a, G6.a, G6.b) | G3.a; dedicated `merchant` query (0.2.0): G6.a + G6.b |
| marketplace (KamiSwap) | kamiden `GetKamiMarketListings/Bids/History` + `shapes/Listing` | chain + kamiden | served (G3.a, G4.a) | G3.a + G4.a |
| trading | `shapes/Trade` + kamiden `GetTradeHistory`/`GetOpenOffers` | chain + kamiden | served (G3.a, G4.a) | G3.a + G4.a |
| quests | `shapes/Quest` + `shapes/Conditional` evaluation | chain | served (G3.a) | G3.a |
| goal | `shapes/Goals` | chain | **not served at 0.2.0** — shapes ported, mirror-only, no dedicated query | — |
| leaderboard | `shapes/Score` + `constants/leaderboards` (kamiden ranking RPCs exist but are ApiKey-gated and uncalled by the client at this pin) | chain + code | served (G3.a, G6.a, G6.b) | G3.a; dedicated `leaderboard` query (0.2.0): G6.a + G6.b |
| gacha / reveal (incl. the `lootBox` droptable-reveal UI — no component of its own) | `shapes/Gacha`, `shapes/Commit` (block-driven commit-reveal) | chain | **not served at 0.2.0** — shapes ported, mirror-only, no dedicated query (the auction side is served, next row) | — |
| gacha: auction price chart | kamiden `GetAuctionBuys` | kamiden | served (G4.a) | G4.a |
| account | `shapes/Account` (stamina, room, reputation, owned kamis) + `eth_getBalance` for the gas block (0.5.0) | chain | served (G3.a, G6.a, G6.d) — **corrected at 0.5.0:** this row and SPEC §1.1 both listed *friends* among what the account answer serves. It never has: no output field and no schema property carries them, and `getAccount` is not asked for the option. The friends/requests/blocked surface is `not served` and now says so, one row down. | G3.a, G6.d |
| account: friends / requests / blocked | `shapes/Friendship` (behind `getAccount`'s `friends` option) | chain | **not served** — shapes ported, mirror-only, no query reaches them. Named at 0.5.0 after the client-parity audit found the claim above; it was never true. | — |
| bridges: wallet flows (`bridge`, `bridgeERC20`, `bridgeERC721`) | wagmi/Initia wallet operations (requires acting) | — | out-of-scope (read-only) | — |
| bridges: deposit/withdrawal history | kamiden `GetTokenDeposits`/`GetTokenWithdrawals`/`GetOpenWithdrawals` | kamiden | served (G4.a) | G4.a |
| dialogue / questDialogue | code-shipped dialogue trees + `shapes/Quest`/room state | chain + code | **not served at 0.2.0** — dialogue trees ported with the pin, no dedicated query (`quests` serves name/description only) | — |
| operator gas balance | `eth_getBalance` on the account's operator and owner addresses (shown by FundOperator/header) | chain | **served (0.5.0)** — the `gas` block on the `account` answer, read at a block the answer names and absent rather than faked when the RPC does not answer | G6.d |
| acting flows: kamiSend, naming (incl. its emaBoard UI), kamiPortal, operatorFund, templeOfTheWheel, obol, presale | acting UIs; their read-side state is served by general queries over the ported `app/cache`/shapes (account, kami, item, config, listings) | — | out-of-scope (read-only) | — |
| starter-vendor purchase flow (`kamiAdoptionAgency`) | the vendor entity's kami pool + cycle anchor (`Values`, `TimeStart`) and the `NEWBIE_VENDOR_CYCLE` config, through the ported display-window computation | chain + code | **the act is out-of-scope (read-only); its read side is served since 0.3.0** by `merchant`'s `newbieVendor` block | G7.a, G7.b |
| studio, help, settings | chrome; no world state (shader viewer, static copy, local prefs — verified by import audit) | — | out-of-scope | — |

## Not modal-bound but player-visible

| Item | Backing state | Source | Status | Gate |
|---|---|---|---|---|
| battle/kill feed | kamiden stream `Feed`, daemon ring buffer served as pull query | kamiden | served (G4.b) | G4.b |
| room presence (other accounts) | `RoomIndex == here` mirror query | chain | served (G3.a, G6.b) | dedicated `room` query (0.2.0): G3.a + G6.b |
| item pools (constant-product item swap venues) | pool entities (`EntityType == POOL`, `Keys`, `Rate`, `Value`, `TimeStart`, optional `IsDisabled`) plus the pool's own inventory rows as reserves | chain | served (G7.a, G7.b) since 0.3.0 — **facts only** (reserves, fee, share supply, creation time, reserve-ratio valuation); no swap quote, see the 0.3.0 section | G7.b (chain cross-check per row). **G2.b display parity is structurally unavailable for this row** — pools postdate the pinned client, which has no pool pane to compare against, so G7.b is this row's whole evidence |

## Standing caveats

- Player-authored strings, measured at the pin: account and kami
  names (≤16 bytes, unique, non-empty), account bio (≤140 bytes of
  free text — surfaced by `shapes/Account` friend/request/blocked
  cards inside served rows), chat messages (no on-chain length cap;
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
| `registry` | item/quest/skill/goal/room/node names & descriptions, NPC dialogue trees, `constants/**` display text (incl. `constants/leaderboards` titles); since 0.4.0 also the interpreted text the pinned client derives from registry allocations and conditions — item effect lines, quest reward lines, item use-requirement text (§3.12 enrichment) |
| `system` | addresses, entity/order/commit IDs, enum & state labels, `MediaURI` values, numeric amounts serialized as proto strings |

Known but unserved: kamiden `RankRow.KamiName`/`OwnerName`
(`authored-id`; `RankRow` is dead proto surface — referenced by no RPC at
the pin). `LeaderboardRow.Name` is **served since 0.2.0** by the `killers`
query (`KillerRow.name`, `authored-id`, classified above) — the flip from
unserved got the mandated hand review with the 0.2.0 change set.
- `code`-sourced rows change only via a pin advance and are diffed by
  the tracking protocol's coverage-affecting bucket (DESIGN §7).

## M3 query surface (2026-07-21)

Served queries at M3: `kami`, `account`, `party`, `node`, `item`,
`items`, `config`, `status`, plus `kami --stateless` (discrete-vitals
subset; projections need the mirror). Checked-in schemas in
`src/queries/schemas/`; string classes in
`docs/string-classification.json`.

**Deferred, explicitly:** `quests`, `trades`, `auctions` listing
queries. The explorer modules are ported and the mirror state is
served (their entities appear in `node`/`account`/`item` answers where
linked); dedicated query outputs with schemas land with M4, where
trade *history* (Kamiden) arrives and the trade/auction surfaces can
be designed once, whole. Not a silent gap: this row is the record.
*Resolved in M4 — see the section below.*

## M4 Kamiden surface (2026-07-21)

Served queries added at M4: `battles`, `market`, `portal`, `transfers`,
`feed`, `chat` (Kamiden-backed passthrough-with-joins; request shapes
are the web client's own, cited per builder in `src/queries/feeds.ts`),
plus the M3-deferred chain trio `quests`, `trades`, `auctions` —
designed whole with their Kamiden halves (trade history/open offers,
auction buy history). Schemas in `src/queries/schemas/`; string classes
in the classification table above (Kamiden payload strings are `system`
— the payloads carry no player text; joined names are `authored-id`;
chat bodies are the release's only served `authored-prose`).

Standing caveats, measured 2026-07-21 (gate G4 evidence,
docs/measurements/g4*-2026-07-21.json):

- **Stream topic filter nonfunctional at this pin.** The server
  recognizes no topic string — every non-empty `topics` list yields
  zero frames while the proto-documented "empty = all" flows — so a
  Messages-excluding filter is inexpressible without killing the feeds.
  The daemon subscribes upstream-style (empty list); the §3.10 chat
  exclusion is enforced at the ingestion drop, hermetically proven and
  counter-surfaced in status. The requested topics stay configurable
  for a future server vocabulary.
- **The server closes the stream every ~40 s** ("Response closed
  without grpc-status"); resubscription is routine (upstream's 5 s
  cadence) and feed events during a reconnect gap are lost — identical
  to the upstream client's exposure. The feed ring buffer is
  best-effort recent history, never a complete log. *User-observed
  corroboration (2026-07-22, filed at M5 audit): the official web
  client left running overnight visibly de-syncs — kamis shown
  near-starved that were actually fed; a full restart resolves it —
  the same clean-close/frame-loss exposure playing out in the browser
  session. kami-lens's mirror heals through Kamigaze gap-fill on
  resubscribe; only the Kamiden FEED rows carry the loss.*
- **Feed delivery is partial — measured, not asserted** (2026-07-22).
  Independent corroboration of the G4 record window against separate
  chain infrastructure: the feed delivered ~71% of chain movement
  writes and ~50% of harvest-ends (45 kills / 51 moves on-chain vs
  34 / 36 served — every served event chain-true; the gap is
  reconnect-window loss plus event-model asymmetry, e.g. portal-class
  moves emit no `Movement`). Own fresh block-anchored probe
  (docs/measurements/g4b-feed-delivery-2026-07-22.json): movements
  3/3, harvest-ends 78/163 ≈ 48%. Consumers needing completeness must
  read chain state (the mirror), not the feed.
- **Liquidation chain signature** (verified by engine-decoded logs on a
  G4-confirmed kill, 2026-07-22): one tx writes the victim's HARVEST
  entity (`hashArgs(['harvest', kamiID])` — id verified byte-exact):
  `State → 'INACTIVE'`, `Value → 0`; AND the victim kami:
  `State → 'DEAD'` (a literal string write), Health sync, Experience.
  Caution for chain-side detectors: engine string components do NOT
  decode with plain `abi.decode(['string'])` — it throws, and a
  try/catch filter silently reports zero events (the trap that
  produced an earlier false "no DEAD writes" reading).
- **Kamiden unary history depth is recorded per gate run, never
  asserted** — service retention is unverified (the same epistemic
  status as `GetEventsSince`).
- `GetOpenOffers` is defined at the pin but uncalled by the web client;
  kami-lens serves it per PORT_PLAN M4 with observed semantics recorded
  by G4.a.
- Chat oversize threshold: bodies over `chatMaxBytes` (default 4096
  UTF-8 bytes; config/env) are withheld-with-receipt, verbatim on the
  explicit `--oversize` override — never truncated (DESIGN §3.10). The
  threshold default is a kami-lens implementation parameter (upstream
  has no receive-side cap; its 200-char limit is send-side input
  validation only).

## 0.2.0 query surface (2026-07-22)

Served queries added at 0.2.0 (all envelope-wrapped, schema-checked,
string-classified; gates G6.a/b/c plus the extended G3.a/G3.f):

- **`inventory <accountIndex|name>`** — any-account item inventory
  (counts + item identity), rows through the inventory modal's own prep
  (`cleanInventories`: zero balances dropped, ascending item index).
  Verified on-chain per row via the deterministic `inventory.instance`
  hash (G6.b).
- **`room <roomIndex>`** — room occupancy: the `RoomIndex == here`
  reverse lookup (the "room presence" row below), each account joined
  with its kamis. Chain cross-check + negative samples in G6.b.
- **`node <index> [attackerKamiIndex] --with-vitals`** — extends the node
  query (identity-only default unchanged) with per-occupant computed
  vitals (HP now/total/percent, HP rate, accrued MUSU, cooldown) and,
  with an attacker kami argument (any kami — a general argument), the
  pairwise liquidation preview the client's LiquidateButton computes:
  `canLiquidate`, threshold, spoils/salvage, recoil. `calcSalvage` is
  exported for this (visibility-only port change, documented in the file
  header — upstream previews only spoils/recoil).
- **`merchant [npcIndex]`** — NPC enumeration; with an index, the full
  chain listing catalog with unit prices via the client's own calcs
  (GDA clock-corrected). Prices never vary by viewer; requirement gating
  is served as interpreted text, not silently applied. Listing
  value/balance/item chain-verified per row (G6.b).
- **`phase`** — world day/night phase (36-hour cycle, 12-hour phases,
  DAYLIGHT/EVENFALL/MOONSIDE) from the ported `getPhaseOf` on the
  corrected clock, plus seconds-to-next-flip. **Measured note:** the
  cycle is pure pinned code anchored at the Unix epoch — no `is.config`
  input exists at this pin, so phase-constant changes arrive as pin
  advances, not config reads. Vector tests in `test/phase.test.ts`;
  boundary arithmetic gated in G6.a.
- **`leaderboard [type] [epoch] [itemIndex]`** — the client leaderboard
  modal's mirror Score query verbatim (`getScoresByFilter`, value-sorted,
  1-based ranks, holders joined to accounts). Defaults are the modal's
  own (`COLLECT`, epoch 1, MUSU). Sampled rows chain-verified via the
  `is.score` hash (G6.b). **Observed at the pin (2026-07-22):**
  `LIQUIDATE` scores live at item index 0 (542 rows) while the client's
  filter pins index to MUSU (=1) on type change — the modal's LIQUIDATE
  view is empty (an upstream quirk, served faithfully; the general query
  reaches the real rows). `FEED` has no score rows at any probed
  epoch/index. `TOTAL_SPENT`/`COLLECT` live at index 1, epoch 1.
- **`killers [size]`** — killer rankings: kamiden `GetKillsByKami`
  passthrough (kami-level kill counts, service-ranked), names verbatim
  (`authored-id`, name-free mode withholds with receipt), mirror
  name-joins add kami id/index (names are unique at the pin; joins
  round-trip-verified in G6.c). The RPC is defined-but-uncalled by the
  web client at the pin — served with observed semantics recorded per
  gate run, the `GetOpenOffers` precedent. Size cap is an explicit
  argument (default 50) with `totalRanked` always served — never a
  silent cap.
- **`account`** now serves `stamina` (current via `calcCurrentStamina` —
  the Clock fixture's display value — plus the stat total). Additive
  field; recompute-checked in G6.a.

**Deferred, explicitly — windowed killer rankings.** A kill ranking over
a caller-chosen time window is not servable from any non-gated source at
this pin, measured 2026-07-22 (gate G6.c records the evidence each run):
the one windowed ranking RPC (`GetKillerRanking`, StartBlock/EndBlock)
is ApiKey-gated and answers empty to an empty key; id-less `GetBattles`
enumeration answers empty; the mirror registers no `IsKill` component
(the ECS kill shapes are dead code at the pin); and the stream feed
buffer is measured-lossy (~50–71 % delivery, see the M4 caveats) — an
aggregate built on it would not be gate-grade. The served `killers`
ranking is the service's own all-time window. Not a silent gap: this row
is the record.

Shape-stability note: 0.2.0 changes to pre-existing outputs are strictly
additive (`account.stamina`; optional `vitals`/`liquidation`/`attacker`
on the node answer, absent without the new flag). No existing field
moved, renamed, or changed type.

## 0.3.0 query surface (2026-08-06)

Four perception additions and one investigation, all chain-sourced. The
principle they share is DESIGN §3.11: **a failure must never cite state the
reader could not have read through the query surface beforehand.** Each
carries a falsifiable prediction, checked by a gate, recorded below with
the change.

- **Per-objective quest progress.** Every objective of an accepted quest is
  served as `[current/required]` with its `type`, its stored `logic`, and a
  `basis` naming how progress is measured: `since-acceptance` (accrual
  counted from the moment of acceptance — spending what you accrued does
  not un-count it, and a balance held beforehand does not count toward it),
  `current` (a present value), `boolean` (met or not, nothing to count), or
  `unknown` (a handler this version does not evaluate). **Progress is
  served for accepted quests only**, and that is correctness rather than
  thrift: accrual is measured against a snapshot written at acceptance, so
  before acceptance the comparison runs against zero and an account's
  lifetime total reads as progress. The reference client's quest-detail
  panel renders exactly that artefact as a checkmark, which its own
  accepted-quest counter then contradicts once the quest is taken; serving
  it would hand a reader a figure the world does not hold (DESIGN §3.11).
  Nothing is synthesized where the world holds no number: boolean
  objectives carry no `current`, and a finished quest's objectives carry
  none either, because the projection stops evaluating them once the quest
  is complete (preserved upstream behaviour — §4.1 quirk 9).
  *Prediction: a reader holding an accrual objective sees its counter
  advance between reads as the underlying total rises, with `required`
  unchanged; and no unaccepted quest ever reports progress. G7.a asserts
  the recompute identity and the pre-acceptance guard over every served
  objective; the between-reads leg is G7.b's, at two pinned blocks.*
- **Account-relative quest state.** Every registry row carries an `account`
  block when the query is given an account, so one read answers which
  quests are the account's and where they stand: `accepted`, `complete`,
  `requirementsMet`, and — for accepted quests — `objectivesMet`, the
  instance times, and the objectives above. The three-way ambiguity
  (never accepted / accepted and unfinished / already finished) is fully
  discriminated here, with `objectivesMet` splitting the middle case
  further. The field is deliberately **not** called "completable": it is
  this layer's evaluation of the objectives it can read, not a promise
  that the finishing transaction will succeed, and a reader needing that
  guarantee must have the chain simulate the act. The pre-existing
  `accepted` list is retained and now redundant, so answers stay
  shape-compatible with consumers written against earlier versions.
  *Prediction: a redundant accept attempt becomes distinguishable from
  state ignorance — the served state answers before the act. G7.a checks
  `accepted`/`complete` against the mirror's own accepted-quest and
  completion queries in both directions, over every registry row for
  every sampled account.*
- **Item pools, by payload enrichment.** `items` serves the whole pool set;
  `item <index>` serves the pools trading that item (an empty array when
  none — never an omitted field). Each row: the pair, both reserves, the
  fee in basis points, the LP share supply, the creation time, a disabled
  flag when paused, and an `impliedRate` that is the **pure reserve ratio,
  fee-exclusive and impact-exclusive** — a valuation of current depth,
  explicitly not a swap quote. No new query: pools are keyed by item
  indices and reserve item balances, so the item registry queries are their
  natural home. **Facts only, deliberately.** The swap-output formula is
  not served: the pinned client carries no pool module, so there is no
  upstream implementation to be faithful to and no differential gate that
  could catch a transcription error in one (DESIGN §6 names quoting as
  deferred to a pin whose client ships the module). Discovery is
  mirror-only — the entity-type component has no on-chain reverse index, a
  fact G7.b probes and records each run — while every served row is
  chain-checkable one entity at a time.
  *Prediction: pool state is readable in the same session that would swap —
  a single answer, read once, carries reserves and fee that are true at the
  block it names. G7.b verifies every served row against pinned chain reads
  (type, pair, fee, supply, creation time, both reserves) and samples
  unpooled pairs for absence, so an omission from the served set is visible
  too.*
- **`roster [accountIndex]` — the compact roster.** One line per kami:
  index, state, `[hp, hpTotal]`, plus the room the account itself is in.
  Full detail stays on `party`, unchanged. The answer carries **no authored
  strings at all** — no kami names, no account name — so its untrusted list
  is always empty and it is byte-identical in name-free mode; identities
  are indices, which is what a reader joins on. Compaction is a payload
  property, not a latency one: every row goes through the same per-kami
  projection the party report uses and is then projected down, so the two
  answers cannot drift apart.
  *Prediction: the compact payload's marginal cost per kami stays at or
  under a quarter of the party report's. Measured at 0.175 over a
  1,053-kami roster (46.9 vs 267.7 bytes per kami; 7.1 kB vs 40.2 kB
  projected at 150 kami); the threshold is frozen at 0.25 in G7.a, and
  raising it is a deliberate act.*
- **Starter-vendor display window (the investigation).** The vendor sells
  only the kamis in its current rotating window and rejects a purchase
  outside it. That window is world state — a stored pool of kami indices, a
  stored cycle anchor, a configured period — and the display computation
  was already ported but reached by no query, while this table asserted
  its read side was covered by general queries. It was not. `merchant` now
  serves `newbieVendor`: the displayed indices, the pool size, the cycle
  anchor and period, and the seconds to the next rotation. The row above is
  split out of the acting-flows blanket row accordingly.
  *Prediction: the reason a purchase would be refused is readable before
  attempting it. G7.a checks the window is sized by the cycle rule and the
  countdown lies inside one period; G7.b checks the served pool size and
  cycle anchor against the vendor entity on-chain and that every displayed
  kami is really in the on-chain pool.*

**Not served at 0.3.0, unchanged:** crafting, goal, gacha/reveal,
dialogue/questDialogue, operator gas balance, and the exit/portal graph
half of map. The 0.2.0 rows stand as written.

Shape-stability note: 0.3.0 changes to pre-existing outputs are strictly
additive (`account` on quest registry rows; `pools` on the item answers;
`newbieVendor` on the merchant enumeration). No existing field moved,
renamed, or changed type, and the redundant `accepted` list was kept rather
than removed for exactly that reason.

**Defect found and fixed by the new gate, affecting 0.2.0 answers.** The
projection cache is cleared before each read to force freshness, and a
cleared entry is rebuilt without its optional sub-objects; the refresh
windows are staleness limits compared with a strict greater-than, so a
window of zero did not mean "always" — two reads of the same kami inside
the same millisecond skipped the refresh entirely. The result was a kami
served with no stats at all, i.e. zero health reported for a healthy kami,
whenever two queries touched the same kami in the same millisecond. This
reached `kami`, `party` and `node --with-vitals` at 0.2.0. Fixed in the
refresh constant (a native module, not ported code — upstream never clears
this cache, so the interaction is this port's to own, and a port defect is
fatal rather than preserved, DESIGN §4.1). Found because G7.a asserts the
compact roster and the party report agree field-for-field: they disagreed,
and the party report was the wrong one.

## 0.4.0 query surface (2026-08-17)

One addition, behind one flag: **the facts a client shows in a tooltip,
served inline where a result names an item or a room and says nothing else
about it** (DESIGN §3.12). Nothing new is queryable — no query, no request
field, no schema field moved or retyped — and with the flag off every answer
is the 0.3.0 answer byte-for-byte.

**The flag.** `enrich`, a daemon-level config key (`--enrich true` /
`KAMI_LENS_ENRICH=true` / `enrich = true`), default **false**, resolved and
provenance-reported like every other key and surfaced in `status.config`.
Booleans are strict: `1` is a startup error, not "on". One daemon serves one
surface — no request field carries enrichment, so a client cannot ask for a
different one, and the CLI's query path (a socket client) decides nothing.

**What each surface gains, and what it deliberately does not** (the
population map — enrichment is payload, and history rows repeat the same 70
rooms and 177 items page after page):

| Surface | Under `enrich` | Not enriched, on purpose |
|---|---|---|
| `inventory` rows, `merchant` listing items | item `description`, `effects.use` / `effects.equip` (one row per raw allo), `requirements` (raw target + interpreted text) | — |
| `item` / `items` | `effects`, `requirements`, `is` (the stored `tradeable`/`disabled` flags); `description` was already served | — |
| `merchant` `payItem` | `description` only — a payment currency is identity, not a use decision | its effects |
| `quests` registry rows | `rewards`: one row per raw reward allo (type/index/value) with the pinned client's interpretation beside it | — |
| `quests` objectives | `room` for target type `ROOM`, `item` for target type `ITEM` | every other index-bearing target type (see below) |
| `account`, `node` | `room`: the bare `roomIndex` resolved to `{index, name, description}` | — |
| `roster` | `room`: `{index, name}` only — the compact answer stays compact | the description (one `room` read away) |
| `trades` open rows and open offers, `auctions` lots | item `description` — these are decision surfaces | — |
| `feed`, `battles`, `portal`, `transfers` | nothing | descriptions on history rows: the same names recur every page, and one `item`/`room` read serves them |

The optional properties exist in every copy of the shared `ItemRef` and
`RoomRef` `$def`s, so the schemas stay uniform and a later population change
is a one-line code change rather than a schema change.

**Two restraints worth stating, because both look like omissions.**

- **A quest objective's index is resolved only for target types `ROOM` and
  `ITEM`** — the two the pinned client resolves against a registry itself
  (`Conditional/interpretation.ts`'s ROOM branch; `getFromDescription`,
  which dispatches on `type === 'ITEM'` exactly). Types that carry an index
  the pin never interprets — `ITEM_BURN` (51 objectives at this pin),
  `DROPTABLE_ITEM_TOTAL` (18), `CRAFT_ITEM` (14), `SCAV_CLAIM_NODE` (30),
  `HARVEST_TIME` (36), `MOVE` (4) — keep the bare index. This is not
  thrift: **the item and room index spaces overlap at low indices** (room 3
  resolves to an item literally named "None", room 25 to a passport), so
  resolving a type the pin does not interpret would attach a plausible wrong
  name. The objective's own `name` already reads "Give 3 Scrap Metal", and a
  bare index a reader can join is worth more than a name it cannot trust.
  At this pin that means 29 room refs and 0 item refs on objectives; the
  `ITEM` path is live for a registry that adds one.
- **Interpreted requirement text is served with its raw target beside it**
  (`{type, index, value, text}`), not as the flat `string[]` the
  `Listing.requirements` precedent uses. Reason, measured: of the 53 item
  USE conditions at this pin, **48 are `KAMI_CAN_EAT` with index 0, whose
  interpreted text is the bare word "None"** — indistinguishable, without
  the target beside it, from a real requirement. The remaining five are 4
  `STATE` ("Is  DEAD ", "Is  RESTING " — upstream's double and trailing
  spaces, verbatim) and 1 `ROOM` ("At Burning Room"). `Listing.requirements`
  itself is unchanged.

**Cost, measured on the fixture at block 31,782,245** (177 registry items,
187 registry quests, 70 rooms). Enrichment adds **no mirror read**: every
fact is already computed on the path that answers today and thrown away at
the projection (`Inventory.item` is a full item shape; so are
`Listing.item`/`payItem`; `getQuest` computes rewards for every registry
row). What it adds is a parse and bytes:

| Answer | Today | Enriched |
|---|---|---|
| `items` (whole registry) | 6.8 ms, 50,830 B | +2.9 ms parse, +21,129 B (**+41.6 %**, 119 B/row) |
| one item read | 0.003 ms | +0.001 ms |
| `inventory`, 12 accounts / 468 rows | 72,067 B | +91,221 B (**+127 %**, 195 B/row) |
| `quests` (registry form) | 15.1 ms, 99,889 B | +2.9 ms parse, +32,961 B (**+33.0 %**); 186/187 rows carry ≥1 reward |
| `merchant <npc>` (9 / 7 listings) | 3,497 / 2,791 B | ≈ +1.1 / +0.9 kB |
| `roster`, 1,050 kamis | 49,250 B | 49,296 B (**+46 B, fixed**) |

Registry facts behind those numbers: 65/177 items carry USE effects, 36/177
carry EQUIP effects, 53 USE conditions in total; effect allo types include
`STAT` (33), `BONUS` (17 use + 36 equip), `XP` (15), `ITEM` (8),
`ITEM_DROPTABLE` (5), `STATE` (4). Item descriptions average 104.6 B (max
268), room descriptions 126.7 B (max 313).

**The `app/cache` note.** `parseConditionalText` resolves a ROOM target
through `app/cache/room`, a permanent memo with no invalidation. That path
is not new — `merchant` has reached it since 0.2.0 through
`Listing.requirements` — and item USE requirements now reach it too, for
exactly one condition in the registry ("At Burning Room"). Recorded rather
than diverted: it is upstream's own path, and the alternative is a port
divergence. The item memo (`app/cache/item`) is deliberately **not** adopted:
enrichment needs no cache (0.001 ms/item), and a permanent memo would make a
registry edit — a new item, a changed effect, a `disabled` flip — invisible
for a daemon's whole lifetime, which is the same class of defect the forced
`KAMI_REFRESH` windows exist to prevent.

**Predictions, each falsifiable, each with the gate that checks it:**

- **Flag off is a no-op.** Every query except `status` answers byte-identically
  to 0.3.0 at the same block; `status` differs by exactly `config.enrich` and
  `configSources.enrich`. *Falsifier: any unmasked leaf differing, any key
  added or removed, or a third status key. G3.g — 25 cases at one snapshot
  block against captures from a 0.3.0 checkout: 25,061 leaves compared
  byte-for-byte, zero mismatches, zero keys added or removed anywhere but
  `status`; 207 leaves masked as clock-dependent, the mask derived by
  perturbing the pinned clock (a leaf that moves when the clock moves is the
  clock's, a leaf that does not is the code's) rather than hand-listed;
  `status.version` asserted equal to the built version instead of masked.
  G3.a additionally scans every flag-off answer for enrichment-only shapes
  and finds none.*
- **One inventory read answers "is this useful to me?"** With the flag on,
  every held row whose registry item has a USE or EQUIP allo carries its
  effect text, and every gated row its raw-plus-interpreted requirement — no
  second call and no document. *Falsifier: a row whose upstream item has a
  non-empty `effects`/`requirements.use` and whose served row lacks the
  matching non-empty field. G3.f's presence set (16 assertions, both
  directions); G3.a validates 134 enriched answers against the same schemas.*
- **Quest rewards are readable before acceptance.** 186/187 registry rows
  carry at least one reward group naming raw `type`/`index`/`value` plus the
  pinned client's interpretation. *Falsifier: a registry quest with rewards
  on-chain and no reward group served.*
- **Enrichment is payload, not reads.** It makes no mirror read the flag-off
  answer did not already make; the parse costs ≤5 ms on the whole registry
  and ≤1.5 ms on an inventory answer. *Falsifier: a read-count or timing
  increase beyond the parse step. Basis: the table above.*
- **The compact roster stays compact and stays name-free.** The room ref is
  fixed overhead, not a per-kami cost, and a room NAME is registry content
  rather than an authored id, so the empty untrusted list and name-free
  byte-identity survive the flag. *Measured under enrich: +46 B fixed,
  marginal 46.86 B/kami — unchanged to six decimals — ratio 0.175 against
  the threshold frozen at 0.25; untrusted `[]`; name-free answer identical.
  G7.a asserts all four, and fails if enrichment charges any per-kami cost.*

Shape-stability note: 0.4.0 changes to pre-existing outputs are strictly
additive and optional (`description` on `ItemRef`/`RoomRef`/`InventoryItem`;
`effects`/`requirements`/`is` on the item answers; `rewards` and objective
refs on `quests`; `room` on `account`/`node`/`roster`; `enrich` in
`status.config`). No existing field moved, was renamed, or changed type, and
every addition is absent unless the daemon runs with the flag — which is why
flag-off byte identity is provable at all.

**Not served at 0.4.0, unchanged:** crafting, goal, gacha/reveal,
dialogue/questDialogue, operator gas balance, and the exit/portal graph half
of map. The 0.2.0 and 0.3.0 rows stand as written.

## 0.5.0 — payload economy, the leveling loop, and three parity gaps

DESIGN §3.13. Two of the standing `not served` rows close here (operator gas
balance; the EXIT half of map's exit/portal graph), one query is added
(`skills`, the 24th), and — for the first time in this project — a set of
DEFAULT ANSWERS GET SMALLER. That last one is why this is a version advance
and not a flag: the old shapes stay reachable through `--full`, but a
consumer reading a default answer sees fewer fields than it did at 0.4.0.

### The measured payload table

Whole-envelope bytes, one fixture mirror at block 31,782,245 (the same
snapshot every hermetic gate runs on), against the 65,536-byte context the
reference agent scaffold gives a tool result. "Before" is the 0.4.0 code on
the same fixture and the same arguments.

| Call | 0.4.0 | 0.5.0 default | smaller by | 0.5.0 `--full` |
|---|---|---|---|---|
| `quests <acct>` (134 accepted) | 155,722 | 30,592 | 5.1× | 184,691 |
| `quests <acct>` (90 accepted) | 141,140 | 37,291 | 3.8× | 170,160 |
| `quests <acct> --open` | 155,722 | **1,222** | **127×** | — |
| `quests <acct> --accepted` | 155,722 | 31,719 | 4.9× | — |
| `quests <acct> <questIndex>` | 141,140 | **1,078** | **131×** | — |
| `quests` (no account) | 100,013 | 8,282 | 12.1× | 100,013 |
| `room 12` (1,561 accounts) | 359,732 | **2,832** | **127×** | 360,187 |
| `room 9` (1,307 kamis) | 178,449 | 1,901 | 93.9× | — |
| `room 4` (360 accounts) | 163,119 | 2,621 | 62.2× | — |
| `node 9 --with-vitals` (732 harvests) | 266,300 | **13,482** | **19.8×** | 346,905 |
| `leaderboard` (1,475 rows) | 174,780 | 3,728 | 46.9× | 174,815 |
| `trades` (382 open) | 111,406 | 11,993 | 9.3× | 111,439 |
| `party 3053` (1,050 kamis) | 281,326 | 18,105 | 15.5× | 377,409 |
| `items` (177 rows) | 50,954 | 15,652 | 3.3× | 50,278 |
| `items FOOD` | 50,954 | 5,289 | 9.6× | — |
| `merchant 1` (9 listings) | 3,621 | 2,822 | 1.28× | 3,820 |
| `inventory 78` (80 rows) | 12,387 | 13,733 | +1,346 — `for`/rarity/disabled | — |
| `kami 219` | 410 | 509 | +99 — the leveling block | — |
| `roster 3053` (1,050 kamis) | 49,374 | 58,736 | +9,362 fixed — the leveling sets | — |
| `skills` / `skills <kami>` | — | 5,833 / 1,065 | new query | — |

Measured by serving the same file in a worktree of `1d7a960` and in this
tree, against the same snapshot, same arguments, whole envelope including
`untrusted` and `meta`. The three rows that grow do so because the release
ADDS a base-surface fact there, and each is named in the row rather than
netted away.

Every default answer in this table now fits in one reader context. **Ten of
them did not before** — six by more than 2×, `room 12` by 5.5×. The `--full`
figures are LARGER than 0.4.0 wherever the release also added a base-surface
field (`party` and `node` carry the leveling block on every row,
`quests --full` carries per-requirement status), which is the honest reading
of `--full`: it restores the uncompacted SHAPE, it does not roll the surface
back to 0.4.0. `items --full` is 676 bytes *smaller* than 0.4.0 for the
opposite reason — `for` is now omitted rather than served as an empty string
on the 77 items that have no target.

`market` is the one family these numbers do not cover: it is Kamiden-backed
and cannot be served from a snapshot mirror. Its rows are capped at 50 each
for listings and bids on the same rule as the rest.

### The leveling loop

| Field | Where | Source |
|---|---|---|
| `xp` | `kami`, `party`, node occupant vitals, `kami --stateless` | `Kami/progress.getProgress` — already forced by `KAMI_REFRESH`, discarded at the projection |
| `xpRequired` | as above, less the stateless mode | `Kami/progress.calcExperienceRequirement` — ported since 0.1.0, never called until now; two config reads, ~1.5 µs |
| `levelUpReady` (+ `levelUpBlockedBy`) | as above, less the stateless mode | derived: `xp >= xpRequired && isResting` — the chain's own precondition, not the looser of the client's two renderings (SPEC §4.2) |
| `skillPoints` (unspent) | as above, less the stateless mode | `Kami/skills.getSkills` — already forced, discarded |
| `levelUpReady` / `skillPoints` SETS | `roster`, on the account block | the same values, placed where they cannot touch the frozen marginal-bytes ratio |
| taken skills with ranks | `skills <kamiIndex>` | `Kami/skills` investments joined to `Skill` registry rows |

Not served, deliberately: skill DESCRIPTIONS and interpreted bonus text are
enrich-class, the same rung as item descriptions. The stateless mode serves
`xp` and stops there — the requirement is a config read and unspent points are
absent from the `GetterSystem` shape, so neither exists without a mirror.

### Client-parity trio

Three facts a player sees passively that no served field carried. All three
are already computed on the path that answers today.

- **Item target (`for`), rarity, disabled flag** on inventory rows and
  merchant listings. One merchant catalog at this pin sells "Maple-Flavor
  Ghost Gum" (`for: KAMI`) beside "Ice Cream" (`for: ACCOUNT`), both
  `type: FOOD`, and the listing served nothing to tell them apart. Whole
  registry cost: 1,142 bytes across 177 items.
- **Room `exits`** — destination index, name, and the conditions stored on
  each. `getExitsFor` has been in the ported tree since 0.1.0 and no query
  ever called it. Measured over all 70 rooms: max 6 exits, **zero isolated
  rooms**, whole-world exit graph 3,410 bytes, 0.026 ms per room. This is
  the one 0.5.0 fact that costs a read the answer did not already make
  (`getAdjacentRoomIndices` probes six neighbouring locations).
- **Liquidation `reason`** on an ineligible preview, from the reference
  client's own tooltip precedence. 38 bytes per ineligible row. On one
  measured pairing, 730 of 732 ineligible rows resolve to `THRESHOLD_ZERO` —
  a fact the bare flag could not distinguish from a cooldown.

Everything else the parity audit found is docketed lab-side and NOT built.

### Gate evidence

| Gate | Result |
|---|---|
| G0 | PASS, exit 0 — 457 tests (was 442) |
| G3.a | PASS, exit 0 — 1,100 validations (was 815), 188 enriched; both modes for every compacted query |
| G3.f | PASS, exit 0 — 37 envelope cases, 19 enriched-presence + **33 base-presence** assertions |
| G3.g | PASS, exit 0 — 40 cases, 31,543 leaves compared, 304 clock-masked; re-based on 0.5.0 |
| G6.a | PASS, exit 0 — 31 leveling comparisons, 388 roster-vs-party rows, 6 skills, liquidation-reason coherence |
| G6.d (new) | PASS, exit 0 — 12 balances against independent live reads, degradation path exercised |
| G7.a | PASS, exit 0 — 2,244 compact quest rows, 1,737 requirement recomputes, 1,050 roster leveling rows, 5 capped listings |

Roster compaction, re-measured on the largest roster in the world
(account 3053, 1,050 kamis): marginal **46.855238 B/kami with the leveling
sets and 46.855238 without them** — identical to six decimals, which is the
whole reason the sets are on the account block. Ratio 0.1304 against the
frozen 0.25. Fixed overhead added: 9,362 bytes.

### Correctness pass (§3.14) — four answers that were wrong and did not look it

| defect | what it served | what it serves now |
|---|---|---|
| config-cache poisoning | `hp: null`, `hpRatePerHr: "NaN"` for every HARVESTING kami, permanently — one arm 856 null rows to 2 real, six days | sentinel reads are never cached, the re-read guard sees NaN, and a non-finite value refuses at the boundary (`NOT_FINITE`) instead of becoming `null` |
| `account` by name / by address | `NOT_FOUND` for accounts that plainly exist (31 of 49 calls on one arm) | the caches use `> 0` as their siblings always did; the owner address is normalised first; `account` also accepts a 0x-address directly |
| `config <name>` | `0` for a name the world has never defined — a fabricated key family read as settled fact for ~20 sessions | `NOT_FOUND`; and a packed uint256 that cannot be a JSON number is ABSENT from `value` rather than served as `1.35e+68`, with `valueRaw` verbatim beside it |
| condition values | `2.65e+76` for an entity-id-sized value | verbatim strings (§1.2) |

Blast radius, measured, correcting the original report: the config poison is
**not** confined to harvesting kamis. Which vitals break depends on which keys
were poisoned — harvest keys break HARVESTING, rest keys break RESTING,
liquidation keys break the preview. "RESTING unaffected" was a property of the
observed incident, not a structural guard.

### Stamina: which number spends

Investigated at 0.5.0 after an arm reported "209–212" in an error text beside
a served `100/100` and stopped trusting the served maximum. The finding is a
divergence, not a lens misread — **and the direction is the opposite of the
obvious one.** The chain's *view* getter returns the recovery accrual
unclamped and that is what its error strings quote; its *write* path clamps
at the total before charging. So the clamped `current` the client and this
surface show is the honest budget, and the unclamped figure is not spendable.
Both are served (`current`, `total`, `raw`) with `raw` documented as the
explanation for the error text and explicitly not an allowance. The arm's
distrust was reasonable and its conclusion was wrong; an unexplained mismatch
is what produced both.

### Freshness (§3.15)

`meta.blockNumber` is a **lower bound**: the highest block whose updates the
mirror had applied when the answer began building. It is not a read-your-writes
guarantee, it does not advance for a block with no world events, and on a
Kamiden-sourced answer it describes the mirror rather than the feed. No gating
mechanism is added; the semantics are stated so a consumer can compare it
against its own transaction receipt.

### Falsifiable predictions for 0.5.0

The 0.3.0 convention: predictions author WITH the changes and are scored at
the close of the next run. A claim that cannot fail is not a claim.

| # | Prediction | Falsified by |
|---|---|---|
| **P5** | No served answer in the next run contains `hp: null`, `percent: null`, or `hpRatePerHr: "NaN"`. The `nonFiniteValues` and `configUnavailable` tripwires stay at zero for the whole run. | any null vital in the telemetry, or either tripwire above zero at close |
| **P6** | `account` answers for every registered account an arm queries, by index, by name and by address, from registration age minutes — zero `NOT_FOUND` on an account that exists on-chain at the queried block. | one NOT_FOUND for an account the oracle shows registered at that block |
| **P7** | Every VM built for the next run installs the version its manifest pins. Four builds of one image produce one version. | any version mismatch between manifest pin and `kami-lens --version` on a run VM |
| **P8** | No arm records a config key that does not exist as a confirmed value; a probe for a fabricated key produces an error in the transcript, not a zero. | a transcript in which a NOT_FOUND-class key is treated as returning data |
| **P9** | `lens_quests` drops below 5% of total tool-output bytes (from 41%), and no `quests`, `room`, `node`, `leaderboard`, `trades` or `party` answer is truncated by the 65,536-byte reader cap. | either threshold missed, or any capped answer among those six |
| **P10** | An arm reads its own XP, next-level requirement and unspent skill points without a workaround, and at least one arm levels a kami — the failure mode being 6,584 banked XP at level 1. | no level-up act across the run despite a kami showing `levelUpReady: true` |
| **P11** (roster-growth watch) | The compact `roster` answer stays inside the 65,536-byte reader cap for every account queried in the next run. The measured bound is **~1,174 kamis** on the largest-roster trajectory (52 B fixed + 46.86 B/kami rows + 8.92 B/kami leveling sets at ~97% skill-point density); the largest roster in the world was 1,050 at 0.5.0. | any roster answer at or above 65,536 bytes — which also means the crossing arrived and the sets need capping |

P11 is a watch rather than a target: it is the one 0.5.0 addition whose cost
GROWS with the thing it describes, and it is ~12% from its ceiling on the
largest roster that exists.

### Pin-advance docket (not 0.5.0 work)

- **Starter-vendor pricing.** The world redeployed the vendor's price rule on
  2026-08-05 — floor-derived, `max(1.10 × cheapest active kami listing,
  0.004 ETH)` — replacing the pinned client's `max(TWAP, 0.005 ETH)`. Both the
  numerator and the clamp changed. **kami-lens is not exposed:** it serves no
  price for the starter vendor at all. `NewbieVendorOut` is five window fields
  (`displayedKamiIndices`, `poolSize`, `cycleStart`, `cycleSeconds`,
  `secondsToNextRotation`), schema-closed, and the pin computes the price in
  Solidity via a system call the lens never makes — it ships only `World.json`
  as an ABI. This is a coverage gap, not a stale number, and the three served
  window fields are untouched by a pricing redeploy. Worth recording: the
  *inputs* to the new rule are served elsewhere (`market` carries live kami
  listings with prices), so a reader who knows the rule could derive the
  floor — nothing connects the two today.

**Not served at 0.5.0:** crafting, goal, gacha/reveal, dialogue/questDialogue,
the account friends/requests/blocked surface, the kami sheet's
traits and equipment (its STATS and affinities are served from 0.5.1), and
the PORTAL half of map's exit/portal graph. The
first two of those are newly NAMED rather than newly unserved — see the
corrections in the rows above.

Shape-stability note: 0.5.0 is the first release whose default answers lose
fields. Nothing was renamed or retyped and no field changed meaning; every
dropped field is reachable through `--full`, and both shapes validate against
one checked-in schema (G3.a, both modes). The additive-only reading of the
SPEC §1.4 row ends here, and that row says so.

## Maintenance

Per release: resolve every `TBD` to `planned`/`deferred`/
`out-of-scope`; flip `planned` to a gate reference once its gate
passes — and only when that gate actually reaches the row, otherwise
the row reads `not served` with an empty *Gate* cell rather than
borrowing a gate that does not cover it; on a pin advance, add rows
for any new modal/fixture found by the classified diff — served or
explicitly deferred, never silent.
