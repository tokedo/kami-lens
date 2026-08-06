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
| kami sheet (stats/traits/skills/equipment) | `shapes/Kami/*`, `shapes/Skill` | chain | served (G2.a, G2.b) | G2.a, G2.b |
| kami sheet: battles tab | kamiden `GetBattles` + `GetBattleStats` | kamiden | served (G4.a) | G4.a |
| node (occupants, ally/enemy threat, scavenge) | `shapes/Node/harvests` mirror query, liquidation calcs, `shapes/Scavenge` | chain | served (G3.b) | G3.b |
| map | `shapes/Room`, `shapes/Portal`, room constants | chain + code | served **in part** (G3.a, G6.b) — the `room` query serves room identity + occupancy; the exit/portal graph is unserved at 0.2.0 | G3.a; the `room` query (0.2.0) adds G6.b |
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
| account | `shapes/Account` (stamina, room, friends, reputation) | chain | served (G3.a, G6.a) | G3.a |
| bridges: wallet flows (`bridge`, `bridgeERC20`, `bridgeERC721`) | wagmi/Initia wallet operations (requires acting) | — | out-of-scope (read-only) | — |
| bridges: deposit/withdrawal history | kamiden `GetTokenDeposits`/`GetTokenWithdrawals`/`GetOpenWithdrawals` | kamiden | served (G4.a) | G4.a |
| dialogue / questDialogue | code-shipped dialogue trees + `shapes/Quest`/room state | chain + code | **not served at 0.2.0** — dialogue trees ported with the pin, no dedicated query (`quests` serves name/description only) | — |
| operator gas balance | `eth_getBalance(operator)` (shown by FundOperator/header) | chain | **not served at 0.2.0** — no balance read on any query path | — |
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
| `registry` | item/quest/skill/goal/room/node names & descriptions, NPC dialogue trees, `constants/**` display text (incl. `constants/leaderboards` titles) |
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

## Maintenance

Per release: resolve every `TBD` to `planned`/`deferred`/
`out-of-scope`; flip `planned` to a gate reference once its gate
passes — and only when that gate actually reaches the row, otherwise
the row reads `not served` with an empty *Gate* cell rather than
borrowing a gate that does not cover it; on a pin advance, add rows
for any new modal/fixture found by the classified diff — served or
explicitly deferred, never silent.
