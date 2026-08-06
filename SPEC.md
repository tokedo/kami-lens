---
module: kami-lens
version: 3
describes: 0.3.0
---

# kami-lens — Contract Registry

What kami-lens promises, what it consumes, and what holds. This is a
registry, not a description of the implementation: every row is a
falsifiable claim and names the thing that would catch it breaking.

`unenforced` is a legal value in the enforcement column and appears
wherever it is true — an empty cell is not. Rationale lives in
[DESIGN.md](DESIGN.md); per-surface release status in
[docs/coverage.md](docs/coverage.md); gate definitions in
[PORT_PLAN.md](PORT_PLAN.md). Where DESIGN states the principle, the
row cites the section rather than restating it.

Gate scripts are `gates/g<N>.sh`; `[live]` parts write dated evidence
to `docs/measurements/`. G0 is the hermetic gate CI runs on every
push.

---

## 1. Provides

### 1.1 Query surface

Twenty-three named queries, plus `status` and one stateless variant.
The authority for what a release serves is the zero-TBD table in
[docs/coverage.md](docs/coverage.md); this table is the contract form
of it. *Needs* is what must be reachable for a non-error answer:
`mirror` = a synced daemon, `kamiden` = the feed service.

| Query | Answers | Needs | Gate |
|---|---|---|---|
| `kami <index>` | single-kami vitals (HP now/total/%, state, cooldown, output) | mirror *or* stateless | G3.a, G3.d, G2.a, G2.b |
| `account <index\|name>` | account identity, room, stamina (current + total), friends, reputation; bio only under `--prose` | mirror | G3.a, G6.a |
| `party [accountIndex]` | every kami of an account with full vitals | mirror | G3.c |
| `roster [accountIndex]` | compact roster: one line per kami (index, state, `[hp, hpTotal]`) + the account's room | mirror | G3.a, G3.f, G7.a |
| `node <index> [attacker] [--with-vitals]` | node + ACTIVE harvests; with the flag, occupant vitals and the pairwise liquidation preview | mirror | G3.b, G6.a, G6.b |
| `room <index>` | room occupancy: accounts present, each joined with its kamis | mirror | G3.a, G6.b |
| `inventory <accountIndex\|name>` | any-account item inventory (zero balances dropped, ascending item index) | mirror | G6.a, G6.b |
| `merchant [npcIndex]` | NPC enumeration (with the starter vendor's display window); with an index, the listing catalog with GDA clock-corrected unit prices | mirror | G6.a, G6.b, G7.a, G7.b |
| `item <index>` / `items` | item registry row / the full registry; both carry item-pool state — pool set, reserves, fee, share supply, reserve-ratio valuation | mirror | G3.a, G7.a, G7.b |
| `config <name> [--array]` | one `is.config` field value | mirror | G3.a |
| `phase` | day/night phase (36 h cycle, 12 h phases) + seconds to the next flip | mirror | G6.a, `test/phase.test.ts` |
| `leaderboard [type] [epoch] [itemIndex]` | mirror `Score` leaderboard, value-sorted, 1-based ranks, holders joined | mirror | G6.a, G6.b |
| `quests [accountIndex]` | quest registry; with an account, every row carries that account's state (accepted / complete / requirements met / objectives met) and accepted rows carry per-objective progress | mirror | G3.a, G7.a |
| `trades [accountIndex]` | open chain trades; with an account, Kamiden history + open offers | mirror (+kamiden for history) | G3.a, G4.a |
| `auctions [itemIndex]` | chain auctions with current GDA price; with an item, Kamiden buy history | mirror (+kamiden for buys) | G3.a, G4.a |
| `killers [size]` | killer rankings (`GetKillsByKami`), service-ranked, mirror name-joins; `totalRanked` always served | mirror + kamiden | G6.c |
| `battles <kamiIndex> [beforeMs]` | kami battle history + stats | mirror + kamiden | G4.a |
| `market [accountIndex]` | KamiSwap listings + bids; with an account, order history | mirror + kamiden | G4.a |
| `portal <accountIndex>` | token deposit/withdrawal history + open withdrawals | mirror + kamiden | G4.a |
| `transfers <accountIndex>` | item transfer history | mirror + kamiden | G4.a |
| `feed [sinceSeq] [type]` | buffered stream feed events | mirror + kamiden | G4.b |
| `chat <roomIndex> [beforeMs] [size] [--oversize]` | paginated `GetRoomMessages`; invoking it *is* the prose opt-in | mirror + kamiden | G4.c |
| `status` | sync state, block lag, effective config + its source level, tripwire counters, per-feed degradation | daemon | G3.a, G3.e |
| `kami <index> --stateless` | discrete vitals via deterministic IDs + `GetterSystem` views, no daemon | RPC only | G3.d |

| Claim | Enforcement |
|---|---|
| Every query above validates against a checked-in JSON schema in `src/queries/schemas/`; schema drift fails the gate. | G3.a (validates all of `QUERY_NAMES` + `status` + `kami-stateless`) |
| Daemon socket, CLI, and library serve the same answers because all three enter through `serveQuery` over one `REGISTRY`. | structural (`src/queries/index.ts`); G3.d compares the stateless CLI answer against the daemon's for the same kami at the same block |
| A quest answer never reports progress on a quest the account has not accepted, and never synthesizes a number where the world holds none (boolean objectives, and the objectives of a finished quest, carry `met` and no counters). | G7.a (the pre-acceptance guard and the no-synthesis checks, over every served objective) |
| Item-pool rows are FACTS ONLY — reserves, fee, share supply, creation time, and a fee-exclusive reserve-ratio valuation. No swap quote is served at this pin. | structural (`poolsQuery`, `src/queries/build.ts`); DESIGN §6 (quoting deferred to a pin whose client ships the pool module) |
| Queries are general: any account, kami, node, or room is an argument — there is no privileged "own" path. `defaultOperator` is a prefill for an argument, never a special path. | structural (`REGISTRY.operatorArg`, `src/queries/registry.ts`); DESIGN §3.6, §5 |
| A discovery answer (`room`, `node` occupancy, `inventory`, `leaderboard`, `merchant`) exists only via the mirror, but every element of it is chain-checkable. | G3.b, G6.b (pinned `eth_call` reads per row, plus negative samples) |
| Documented CLI exit codes: 0 success · 1 query error / daemon fatal · 2 usage · 3 `ERR_NO_SNAPSHOT_SOURCE` · 4 daemon unreachable · 5 `REQUIRES_DAEMON`. | G3.d (5). Codes 1/2/3/4 are numerically **unenforced** — no gate asserts an exit status for them, and the 3-mapping is structural (`src/cli.ts`). G1.e enforces the *refusal* on the library path: the `ERR_NO_SNAPSHOT_SOURCE` marker on the `daemon.start()` throw, plus never-LIVE |
| Documented query error codes: `NOT_FOUND`, `BAD_ARGS`, `KAMIDEN_UNAVAILABLE`, `CHAT_DISABLED`. | structural (`QueryError`, `src/queries/build.ts`); `CHAT_DISABLED` gated by G4.c; `KAMIDEN_UNAVAILABLE` **unenforced** (see §2, Kamiden) |

### 1.2 Response envelope

| Claim | Enforcement |
|---|---|
| Every response — CLI, socket, or library — is `{data, untrusted: [paths], meta}`. Envelope delivery *is* the contract consumers rely on; there is no unwrapped path. | G3.f; `test/envelope.test.ts`; DESIGN §3.10 |
| `untrusted` lists the dot/`[]` paths of authored-class strings **present** in `data`; an empty list is a legal answer, never an omission. | G3.f; `test/envelope.test.ts` |
| The list is derived from (checked-in output schema × `docs/string-classification.json`), never hand-maintained; divergence fails CI. | G3.f |
| `meta` carries `servedAt`, `blockNumber`, `stale`, `mode` (`daemon`\|`stateless`), and `suppressed` when anything was withheld. | G3.a (status/meta schema), G3.e (`stale` under degradation), G3.f + G6.c (`suppressed`) |
| Values inside `data` are verbatim: never truncated, rewritten, or normalized. | G4.c (oversize withhold-with-receipt, `--oversize` serves verbatim); DESIGN §3.10 |

### 1.3 Taint / classification model

| Claim | Enforcement |
|---|---|
| Four classes, per pin: `authored-id` (kami/account names), `authored-prose` (account bio, chat bodies), `registry` (game-content text from registries or pinned code), `system` (addresses, IDs, enums, numerics-as-strings). | `docs/string-classification.json` (pin-keyed); prose form in docs/coverage.md; DESIGN §3.10 |
| Fail-safe: a string field not listed in the artifact resolves to `authored-prose` — the strictest class. New upstream fields arrive untrusted. | `test/envelope.test.ts` ("falls back to authored-prose for unclassified strings"); `classification.default` in the artifact |
| `authored-prose` is never volunteered: pruned from every default output, report, and aggregate. Opt-in only (`--prose`, or the dedicated `chat` query). | G3.f; G4.c (fixture-seeded sweep of every non-chat query asserts zero message bodies anywhere in output); `test/envelope.test.ts` |
| `authored-id` is inline by default and **always** tagged. | G3.f; `test/envelope.test.ts` |
| The compact `roster` answer carries no authored strings at all: its `untrusted` list is always empty and the answer is byte-identical in name-free mode. | G3.f (both modes, derived not asserted); G7.a |
| `authored-id` is parity-bounded — names appear only where the official client shows names, never in novel aggregations. | **unenforced** — a review-time property of the checked-in schemas; no gate asserts name placement. G2.b compares displayed values, not which fields carry names |
| Name-free mode (`--no-authored`) is first-class: value deleted, path recorded in `meta.suppressed`, stable IDs kept for joins. | G3.f; G6.c (asserts `rows[].name` absent and receipted on `killers`); `test/envelope.test.ts` |
| Classified types added at 0.3.0: `QuestObjective` (`name` registry; `type`/`logic`/`basis` system), `Pool` (`id` system), `RosterKami` (`state` system). | G3.f |
| The classification artifact is keyed by schema `$def` type × property, so a new query reusing a classified type inherits its classes. | structural (`classifyPaths`, `src/queries/envelope.ts`); G3.f |
| Changing the classification artifact gets the same mandatory hand review as a formula-affecting diff. | DESIGN §7 (process, not script) — `unenforced` by machine |

### 1.4 Pin semantics

| Claim | Enforcement |
|---|---|
| A release names exactly one upstream pin, in the `UPSTREAM` file at the repo root. | G5.d |
| `kami-lens --version` prints the package version and the pin commit, from the built `dist/`. | G5.d |
| A pin advance that leaves query names, output schemas, and envelope paths unchanged is **non-breaking** for consumers. It may change *values* (upstream formula or constant changes are the point of the pin). | schemas are checked in; G3.a fails on drift |
| A pin advance re-runs, at minimum: the classified diff (formula- / classification- / state- / sync- / coverage-affecting buckets), G2.a, G2.b, G1.b, G3.f. | PORT_PLAN "Order and pin advances"; DESIGN §7 |
| A pin advance only lands after live parity gates re-pass against the running game — the diff says where to look, the gate says we got it right. | DESIGN §7; G2.a/G2.b are `[live]`-anchored |
| A lens-version advance may add queries and may add fields; 0.2.0 moved, renamed, and retyped nothing. | docs/coverage.md shape-stability note; **unenforced** — no gate asserts additive-only schema evolution across versions |
| `code`-sourced data (room constants, phase constants, the 180 s cooldown fallback, leaderboard titles) changes only via a pin advance, never via a config read. | DESIGN §3.3; docs/coverage.md; phase specifically: `test/phase.test.ts` + G6.a |

---

## 2. Depends

Every consumed contract, its pin or measured value, and the assumption
kami-lens makes about it.

| Dependency | Pin / measured value | Assumption | Enforcement |
|---|---|---|---|
| **Upstream client codebase** | `Asphodel-OS/kamigotchi` @ `ef898fc9350a6085fb080419b12af96c2254e8f3` (commit-date 2026-07-16, pinned 2026-07-20) | The calc and shape modules are plain TS, importable from a fresh clone of the pin; their integer math is the reference. | G2.a imports them from a fresh clone and diffs every kami in the mirror, zero tolerance |
| **Kamigaze** (`api.prod.kamigotchi.io`) | service, unversioned | **HARD cold-start dependency.** `GetStateBlock`/`GetComponents`/`GetState`/`GetEntities` bootstrap; `SubscribeToStream` push; `GetEventsSince` heal. A nonce change forces a full reload. | G1.a (bootstrap reaches LIVE, >10⁵ entries); G1.e (refuse-and-report when absent); nonce bumps counted as a tripwire |
| ” | `GetEventsSince` retention | **Unverified.** Depth is recorded per gate run, never asserted. | recorded in `docs/measurements/`; asserting it is out of contract |
| **Public Yominet RPC** | chain `428962654539583`, world `0x2729174c265dbBd8416C6449E0E813E88f43D0E7`, initial block `44577` | Baked zero-config defaults. | G5.a (zero-config clean-room install reaches LIVE) |
| ” | `eth_getLogs` range cap 1,000,000 blocks | Gap-fill chunks below it. | DESIGN §4.1 (measured 2026-07-20) |
| ” | log retention ≈ 1.02 M blocks ≈ 25 days (re-measured 1,025,971 blocks @ head 31,230,021, 2026-07-22, drift 0.6 %) | An outage beyond the window cannot be healed from RPC at all. | G1.f re-measures by bisection each run, asserts a >100 k floor, and flags DESIGN §4.1 on >20 % drift |
| ” | beyond retention: empty result, **HTTP 200 — not an error** | "Empty from an old range" is treated as suspect, never as proof of no events. | DESIGN §4.1; G1.e (the refusal this fact motivates) |
| ” | `eth_call` state depth ≈ 50–120 blocks (measured 2026-07-21: ok@50, reverted@120) | Chain cross-checks must pin reads close to head; deeper reads revert. | recorded per run in `g3b-*` / `g6b-*` measurements and consumed as a gate-side constraint (two-stage heal + pooled reads); **not asserted** |
| **Kamiden** | service, unversioned | **SOFT dependency.** 14 unary methods served (`GetBattles`, `GetBattleStats`, `GetTradeHistory`, `GetOpenOffers`, `GetKamiMarketListings`/`Bids`/`History`, `GetTokenDeposits`/`GetTokenWithdrawals`/`GetOpenWithdrawals`, `GetItemTransfers`, `GetAuctionBuys`, `GetKillsByKami`, `GetRoomMessages`) plus the `Feed` stream. | G4.a (each unary: live call → decode → schema-valid → every entity ID resolves in the mirror at the same block); G6.c (`GetKillsByKami`) |
| ” | outage behavior | Degrades exactly the Kamiden-sourced rows with `KAMIDEN_UNAVAILABLE`, visibly and per-feed in `status`; chain rows and daemon liveness are never coupled to it. | structural (`REGISTRY.kamiden` flag → `KamidenQueryError`); per-feed state in the `status` schema (G3.a). **No gate exercises a Kamiden outage** — `unenforced` end-to-end |
| ” | feed delivery completeness | **Partial, measured, never assumed:** ~48–71 % of chain events over probed windows; the server closes the stream every ~40 s and frames in the reconnect gap are lost. Consumers needing completeness must read the mirror. | measured in `g4b-feed-delivery-2026-07-22.json`; recorded per G4.b run |
| ” | stream topic vocabulary | **None at the pin:** every non-empty `topics` list yields zero frames. A Messages-excluding filter is inexpressible; exclusion is enforced at ingestion instead. | G4.b probes and records the behavior, then asserts either no `Message` frames arrive or the ingestion-drop counter accounts for every one that does |
| ” | ranking endpoints | `GetKillerRanking` (windowed) is ApiKey-gated and answers empty to an empty key. | G6.c records the evidence each run (the windowed-ranking deferral) |
| **Node** | `>= 20` | `v8.serialize` state snapshots are Node-version-coupled; the cache is disposable by design. | `package.json` engines; G5.a installs the tarball in a fresh `node:20` container |
| **License** | AGPL-3.0-only | Derivative of the AGPL-3.0 upstream client; every ported file carries a provenance banner naming its upstream path at the pin. | G5.d (LICENSE present, `package.json` license matches, banner walk over every `src/**/*.ts`) |

---

## 3. Invariants

| Claim | Enforcement |
|---|---|
| **No mutation of the world.** kami-lens never signs or submits a transaction: upstream's transaction executor, system executor, burner wallet, and network-layer assembly are not ported. | by construction — the omission is named in the provenance banners of `src/engine/executors/index.ts`, `src/network/index.ts`, `src/network/setup/index.ts`, `src/clients/kamiden/index.ts`; G5.d walks every banner. **No gate asserts the absence of a write path at runtime** — `unenforced` at that level |
| **No mutation of values.** Served strings are verbatim or absent-with-receipt — an oversize chat body is withheld with a receipt and a raw-fetch override, never truncated or rewritten. Nothing altered, nothing silently dropped. | G4.c; `test/envelope.test.ts`; DESIGN §3.10 |
| **The lens only chooses what it volunteers.** Composition is a property of the envelope, not of the data shapes: reclassification changes what is listed, never what a field is called. | G3.f; DESIGN §3.10 (envelope-over-in-band rationale) |
| **Prose is never volunteered** — absent from every default output, report, and aggregate; flag-gated everywhere. | G3.f; G4.c (sweep of every non-chat query for message bodies); `test/envelope.test.ts` |
| **Names are inline, always tagged; name-free mode is first-class** (values withheld with receipt, stable IDs intact). | G3.f; G6.c; `test/envelope.test.ts` |
| **Every parity deviation is excused explicitly or the gate fails.** The G1.b excusal engine proves each candidate row mechanically — absent on-chain at the pinned block, zero events within the retention window, re-served by Kamigaze on a fresh fetch — records the proofs, and counts the excusals. **There is no human-waiver path.** Value differences, mirror-present/chain-absent, and unproven mismatches always fail. | G1.b (`gates/g1/a-bootstrap.mts`, excusal engine); G2.a (zero tolerance, no excusal at all) |
| **Port defects are always fatal to the gate; upstream defects are excused only with mechanical proof, counted, and surfaced.** | DESIGN §4.1; G1.b, G2.a |
| **Clock discipline:** projection reads offset-corrected stream block time, never the wall clock. | `test/clock.test.ts` — including a static scan asserting the projection trees carry no naive `Date.now()` reads; G2.c (±120 s skewed container must produce identical projections) |
| **Undecodable rows are skipped, counted, and surfaced — never fatal.** Upstream aborts the whole sync attempt; the port drops the row and increments a tripwire. | `test/decode-skip.test.ts` (snapshot and stream paths, separately); tripwire counters in `status` |
| **Tripwires are surfaced, not silent:** unknown `componentId`, decode failures, and Kamigaze nonce bumps are each counted and shown in daemon status. | `src/tripwires.ts`; `status` schema validated by G3.a; DESIGN §7 |
| **Refuse-and-report cold start.** Without a snapshot source and without an RPC whose log history covers the world's full span, the daemon exits non-zero with `ERR_NO_SNAPSHOT_SOURCE` rather than reaching LIVE over a hollow world. | G1.e (refusal marker + never-LIVE; numeric CLI code unasserted) |
| **Degraded state is honest.** With Kamigaze unreachable mid-session, status reports the degraded state within one stall interval and queries still serve last-synced state stamped `stale: true`. | G3.e (live daemon behind a proxy that is killed mid-session) |
| **Chat is excluded from stream ingestion at the ingestion point**, not merely by transport promise: the drop is proven hermetically through the exact live ingestion path. | G4.b (either zero `Message` frames or the drop counter accounts for every one); G4.c |
| **Clean-room install → live answers, zero config.** `npm pack` → install in a fresh `node:20` container → `kami-lens daemon` with no config file reaches LIVE → a sample query returns schema-valid JSON, every step exit-code-checked. | G5.a; G5.b (container lifecycle, warm restart beats cold, healthcheck) |
| **Config precedence is flag > env > file > default**, with the producing level visible in the effective-config block of `status`. | G5.c (pairwise across all four levels) |
| **Source-completeness from a fresh clone.** A checkout must install, lint, typecheck, build, and pass every vector test with no machine-local file. *(This failed once, silently: an unanchored `data/` ignore swallowed committed source. Fixed at a0a3e1e; CI is the standing check.)* | CI (`.github/workflows/ci.yml` → `gates/g0.sh`) on every push |
| **The gate suite is order-independent.** Replay bases are pinned per fixture set in a manifest, and consumers refuse-and-report when the base is missing, block-mismatched, or postdates an observation — never a silent wrong-state comparison. | `replayBase` manifest in `gates/fixtures/g2b-observations.json` + the refuse-and-report guards in G2.b and G3.c |
| **Human observation is data; the verdict is always the script's exit code.** Screenshots are dropped in unedited; transcription, tolerance, and zero-bias checks are machine-side. | G2.b, G3.c (fixtures protocol); PORT_PLAN gate philosophy |

---

## 4. Deliberate deviations

### 4.1 Upstream quirks preserved bug-for-bug

Parity **requires** these. A rework must not "fix" them; fixing one is
a parity break, not a cleanup.

**Ten behavioral quirks:**

| # | Quirk | Where |
|---|---|---|
| 1 | `network/comps` is a phantom import specifier — no such module exists upstream; it survives only because the import is type-only and esbuild erases it unresolved. Ported bodies keep the specifier verbatim. | `src/network/comps.ts` (shim) |
| 2 | Two shapes files use the module **namespace** of a `.png` import (`{default: url}`), not the URL string, as an image value. Mirrored exactly. | `src/assets/images/icons/placeholder.png.ts`; consumers `network/shapes/utils/parse.ts`, `network/shapes/Allo/interpretation.ts` |
| 3 | `network/explorer/trades/index.ts` is an empty barrel; the explorer assembly imports `./trades/trades` directly — so does the port. | `src/queries/feeds.ts` |
| 4 | `getHarvest`'s `{kami: true}` branch resolves the wrong getter and returns a hollow Kami carrying the harvest's id — signature-compatible, so even a typecheck passes. Dormant upstream (no caller passes the option); kami-lens callers use `getHarvestKami`. | `src/network/shapes/Harvest/types.ts` |
| 5 | `IsKill` is never registered, so the ECS kill shapes are dead code at the pin. Ported as-is; the `killers` query therefore reads Kamiden, not the mirror. | `src/network/shapes/Kill/queries.ts` |
| 6 | The chat cache paginates **backward** from `messages[0]` and prepends, while `getLastTimestamp` reads from the array tail. | `src/app/cache/chat/chat.ts` |
| 7 | `cleanInventories`' comment claims it removes MUSU; its code does not — the removal lives in the modal's item-grid filter. The port applies both steps, in that order. | `src/queries/build.ts`; asserted in `gates/g2/b-display-parity.mts` |
| 8 | The leaderboard modal pins `itemIndex` to MUSU on a type change, so its LIQUIDATE view renders empty although 542 rows live at index 0. Served faithfully; the general `leaderboard` query reaches the real rows. | docs/coverage.md, 0.2.0 section; G6.b |
| 9 | Objective evaluation short-circuits on a finished quest: it returns "met" with no counters at all, so a completed quest's objectives carry no numbers. Preserved — the served surface reports `met` and omits `current`/`required` rather than back-filling them. | `src/network/shapes/Quest/objective.ts`; asserted by G7.a |
| 10 | The deterministic-id helper caches on the joined ARGUMENTS only, ignoring the argument TYPES, so hashing the same arguments under two different typings returns the first typing's id for both. Latent upstream (no call site hashes one argument list under two typings); it is a live trap for any new deterministic id, since a wrong typing can be masked by an earlier correct one in the same process. | `src/network/shapes/utils/IDs.ts` (`hashArgs`, the `IDStore` key) |

**Thirty-four preserved type holes across fourteen files:** each is an
upstream type defect that vite never typechecks, kept as
`@ts-expect-error` with a one-line note rather than repaired.

| Claim | Enforcement |
|---|---|
| Quirks on the calc path cannot drift without the differential gate seeing it. | G2.a (imports the pinned upstream modules from a fresh clone; integer math must match exactly) |
| A preserved type hole cannot be silently "fixed": `@ts-expect-error` is self-falsifying — if the underlying defect goes away, `tsc` errors on the unused directive. | G0 step 3 (`tsc --noEmit`), run in CI on every push |
| Each quirk is on the record at its site, in the provenance banner or an adjacent comment. | G5.d (banner walk); the notes themselves are `unenforced` prose |

### 4.2 Documented divergences from upstream

| Divergence | Why | Enforcement |
|---|---|---|
| **Refuse-and-report cold start** where upstream, configured without a snapshot source against a pruned RPC, would silently replay empty ranges and report LIVE over an incomplete world. | Fail loudly, never lie (DESIGN §3.1). | G1.e |
| **Undecodable rows skipped and counted** where upstream aborts the sync attempt into a dead client. | Forward-looking robustness against contract-side drift (DESIGN §4.1). | `test/decode-skip.test.ts`; tripwire in `status` |
| **Stale-`RevealBlock` phantom rows excused.** Kamigaze serves rows whose on-chain values were removed before the log-retention window; each is excused only by the three-part mechanical proof, counted, and recorded. | Kamigaze-inherited, not a port defect (DESIGN §4.1). | G1.b excusal engine; `docs/measurements/g1b-stale-reveal-rows-2026-07-20.json` (15 rows swept, 1 stale) |
| **Chat excluded at ingestion**, not at the transport topic filter. | The server has no topic vocabulary at the pin; a Messages-excluding filter is inexpressible without killing the feeds (DESIGN §3.10, PORT_PLAN G4.b amendment). | G4.b (drop proven through the exact live ingestion path); G4.c |
| **Resubscribe on a clean stream end.** Upstream's loop retries only on a throw, so a clean server-side end silently kills the stream; a daemon must resubscribe — counted and surfaced. | Daemon lifetime ≫ page lifetime. | `src/kamiden.ts` (resubscribe counter in `status`); G4.b |
| **Explicit Kamiden lifecycle** replacing upstream's import-side-effect singleton with its perennial 5 s-retry stream. | Soft dependency under daemon supervision (DESIGN §3.2). | `src/kamiden.ts`; per-feed state in `status` (G3.a) |
| **`calcSalvage` exported** (upstream keeps it module-private; its UI previews only spoils and recoil). | The node liquidation preview serves the salvage side. Visibility-only — no formula change. | G2.a (formula identity); file banner |
| **Periodic checkpointing** where upstream persists the state cache exactly once per session. | A daemon has no page-reload cycle (DESIGN §3.5). | G1.d (warm restart converges to the same state hash and beats cold time-to-LIVE) |
| **`Date.now()` → `clock.now()`** at every projection call site. | Clock discipline (DESIGN §3.8). | `test/clock.test.ts` static scan; G2.c |
| **Numeric progress served for objective types the reference client hides.** Its quest card suppresses the `[current/required]` readout for three types; the served surface carries the numbers for every type that has them. | Truth surface over pane mirroring (DESIGN §3.11): the pane's suppression is an editorial choice, and a machine reader needs the number to decide. | structural (`toObjectiveOut`, `src/queries/feeds.ts`); G7.a asserts the numbers against a recompute |
| **Progress withheld before acceptance**, where the reference client's quest-detail panel renders such an objective as satisfied. | The client's own accepted-quest counter contradicts it; the number is an artefact of a snapshot that does not exist yet (DESIGN §3.11). | G7.a (the pre-acceptance guard) |
| **Projection refresh windows forced unconditional.** The windows are staleness limits compared with a strict greater-than, so zero did not mean "always": two reads of one kami inside the same millisecond skipped the refresh, and since this layer clears the cache before each read — upstream never does — the rebuilt entry was served without its optional sub-objects, reporting zero health for a healthy kami. | A port defect is fatal, not preserved (DESIGN §4.1). The interaction is this port's, since the cache clear is. | `KAMI_REFRESH` (`src/queries/build.ts`); G7.a asserts roster and party agree field-for-field, which is what caught it |
| **Port hygiene** (DESIGN §4.1): replay floor seeded from snapshot/initial block; explicit no-stream mode for gap-fill; the dead `maybeThrow` test helper not lifted; tolerant `componentIDs.json` parse; browser-only `mode: 'cors'` dropped. | Upstream artifacts that are defects rather than behavior. | G1.a, G1.c; G0 |

### 4.3 Known residual — unenforced

| Claim | Enforcement |
|---|---|
| The gates-library replay primitive `replayOnto` **silently no-ops** when the base block already postdates the target (`fromBlock > toBlock` returns early). Both current consumers (G2.b, G3.c) carry refuse-and-report guards, so no live gate can hit it today — but the primitive itself does not refuse. | **unenforced** at the primitive (`gates/g1/lib.mts`). Backlog: loud-guard-at-primitive (DESIGN §6) |

---

## 5. Non-goals

| Excluded | Enforcement |
|---|---|
| **Acting.** Read-only; never signs or submits transactions. | DESIGN §2; §3 row 1 above |
| **History and analytics** beyond what the client shows a player in-session. | DESIGN §2, §3.7 |
| **A hosted service.** No central deployment, no API keys, no accounts. | DESIGN §2; README principle 2 |
| **Oracle/investigator-grade analytics.** The parity reference is the community-standard environment (official client plus widely-used community tooling); exposure beyond it stays out. | DESIGN §3.7 (2026-07-21 amendment) |
| **Notifications digest ("alerts").** Every input is served; the derived digest needs its own design pass. Deferred, with a coverage row. | DESIGN §6; docs/coverage.md |
| **Windowed killer rankings.** Not servable from any non-gated source at the pin — the one windowed RPC is ApiKey-gated, id-less `GetBattles` answers empty, `IsKill` is unregistered, and the stream feed is measured-lossy. The served `killers` ranking is the service's own all-time window. | G6.c records the evidence each run |
| **SQLite persistence.** Upgrade trigger: sustained checkpoint cost (serialize > ~2 s, or observable stalls). | DESIGN §6 |
| **Continuous differential oracle testing** (vendored upstream calc modules in-repo). The gate-time variant exists as G2.a. | DESIGN §6 |
| **Single-binary packaging.** | DESIGN §6 |
| **Fixture-set replay-base pinning at capture time.** The current manifest pins a reconstructed base with a recovery note; the next capture event pins from day one. | DESIGN §6 (0.2.0 audit residual) |

---

## 6. Changelog

| Version | Describes | Change |
|---|---|---|
| 1 | 0.2.0 (`a0a3e1e`, pin `ef898fc9`) | First registry. Enumerates the 22-query surface plus `status` and the stateless variant; the envelope; the four-class taint model; pin semantics; 15 consumed-contract rows; 18 invariants; 8 preserved quirks + 34 type holes across 14 files; 10 divergences; 1 unenforced residual; 10 non-goals. |
| 3 | 0.3.0 (pin `ef898fc9`) | Four perception additions and one investigation, under DESIGN §3.11 (a failure must never cite state the reader could not have read beforehand). New `roster` query (23rd) with the empty-untrusted-list property. `quests` gains account-relative state per registry row and per-objective progress for accepted quests, with progress withheld before acceptance. `item`/`items` gain item-pool state by enrichment — facts only, no swap quote. `merchant` gains the starter-vendor display window, and the coverage row that had wrongly claimed that read side was already served is split out and corrected. Three classified types, two preserved-quirk rows (9, 10), three divergence rows, one gate (G7.a hermetic + G7.b live). One 0.2.0 defect fixed: the projection refresh windows could serve a kami with no stats when two reads landed in the same millisecond. |
| 2 | 0.2.0 (`a0a3e1e`, pin `ef898fc9`) | Registry corrections from the independent audit of v1. Exit-code enforcement restated to what the gate actually asserts (§1.1, §3: G1.e proves the `ERR_NO_SNAPSHOT_SOURCE` refusal marker and never-LIVE on the library path; codes 1/2/3/4 numerically unenforced, the 3-mapping structural). Non-goal §5 parity-reference cite made self-contained. No claim added or withdrawn; the described artifact is unchanged. |
