# Upstream client architecture

How the official Kamigotchi web client syncs and projects world state.
Source: `Asphodel-OS/kamigotchi` @ `ef898fc9` (2026-07-16). All paths
are relative to that repo. Kamigotchi uses **MUD classic** (vendored
solecs), not MUD v2 — this shapes everything below.

## 1. Repo layout

pnpm monorepo (`pnpm-workspace.yaml`: `packages/**`), two packages:

- `packages/contracts` — Foundry. `src/solecs/` is a vendored MUD
  classic solidity ECS (World.sol, Component.sol, BareComponent.sol,
  LibQuery.sol). `src/components/` (95 registered components;
  `deploy.json` / `componentIDs.json`), `src/systems/` (incl.
  read-only `GetterSystem.sol`), `src/libraries/` (LibKami,
  LibHarvest, LibInventory… — canonical formulas).
- `packages/client` — Vite + React 19 + TS. Layers:
  - `src/engine/` — vendored fork of MUD classic **recs**
    (Component/Entity/Query/Indexer/World), providers, executors
    (tx queue), encoders (ABI decode of component values).
  - `src/workers/` — the sync web-worker (`workers/sync/`).
  - `src/network/` — `setup/setupMUDNetwork.ts`, component defs,
    **"shapes"** = typed entity readers
    (`network/shapes/{Kami,Harvest,Node,Account,Inventory,Quest,
    Trade,…}`), `network/explorer/` (a read API over the mirror),
    player tx API (`network/api/`).
  - `src/clients/` — gRPC-web clients: `clients/kamigaze/`
    (snapshot+stream) and `clients/kamiden/` (chat/feeds).
  - `src/app/` — React UI + **`app/cache/`**: the derived-state
    layer (all live calcs).
  - `src/cache/` — IndexedDB wrapper.

## 2. Sync layer

### Initial load
`workers/sync/Worker.ts`, `SyncWorker.init()` (lines 131–377):
config → backfill → save cache → live stream → gap fill →
initialize → live.

1. IndexedDB warm cache (`workers/sync/state/loaders.ts`; DB id
   `ECSCache-<chainId>-<worldAddress>-v5`).
2. Kamigaze snapshot (`workers/sync/snapshot/fetch.ts`,
   `clients/kamigaze/proto.ts`, service `kamigaze.KamigazeService`):
   `GetStateBlock` → `GetComponents(fromIdx)` →
   `GetState(fromBlock, removals:true)` →
   `GetState(fromBlock, removals:false)` → `GetEntities(fromIdx)`.
   Incremental from the cached block; a `nonce` mismatch forces full
   reload. Values ABI-decoded client-side (`engine/encoders`).
3. **No snapshot URL configured → still works**: pure-RPC event
   replay is an explicit code path.

### Staying live
- Primary: Kamigaze `SubscribeToStream` — per-block
  `{blockNumber, blockTimestamp, ecsEvents[],
  transactionsConfirmed[], prevLogBlockNumber, prevLogIndex}`
  (`workers/sync/stream/stream.ts`). Keepalive 10 s; retry with
  backoff; continuity via `prevLog*`; gaps healed by
  `fetchGapEvents` (`workers/sync/stream/gapfill.ts`): Kamigaze
  `GetEventsSince`, fallback RPC `eth_getLogs`.
- RPC fallback stream: `createLatestEventStreamRPC`
  (`workers/sync/utils.ts` 113–140) — block-number stream + replay
  of `ComponentValueSet` / `ComponentValueRemoved` World events
  (`workers/sync/evm/`). These two events fire on every component
  write — **full state is reconstructible from logs alone**.
- Worker → main thread (`workers/create.ts`) →
  `applyNetworkUpdates` (`network/setup/utils.ts`) → recs stores.

### Endpoints (production values in upstream `README.md` ~100–130)

| Var | Production value |
|---|---|
| `VITE_CHAIN_ID` | `428962654539583` (Yominet) |
| `VITE_WORLD_ADDRESS` | `0x2729174c265dbBd8416C6449E0E813E88f43D0E7` |
| `VITE_INITIAL_BLOCK_NUMBER` | `44577` (world deploy block) |
| `VITE_RPC_TRANSPORT_URL` | `https://jsonrpc-yominet-1.anvil.asia-southeast.initia.xyz` |
| `VITE_RPC_WS_URL` | `wss://jsonrpc-ws-yominet-1.anvil.asia-southeast.initia.xyz` |
| `VITE_KAMIGAZE_URL` | `https://api.prod.kamigotchi.io` (snapshot + stream + Kamiden) |

Public chain infra (Initia RPC/WSS) alone suffices for complete ECS
sync. `api.prod.kamigotchi.io` hosts the two game-team gRPC-web
services — Kamigaze (accelerator + stream) and Kamiden (chat, kill
feed, trade history, KamiSwap listings, rankings). Kamiden data is
derived/historical and **not in ECS state** — chat and feeds exist
only there. Both appear unauthenticated; rate limiting exists
(`isRateLimited` in `workers/sync/snapshot/`).

### State store
Worker-side `StateCache` (`workers/sync/state/cache.ts`):
`{components[], entities[], state: Map<packTuple(componentIdx,
entityIdx) → decoded value>, blockNumber, …}`, persisted wholesale.
Main-thread: recs — one store per component, rxjs `update$` streams,
`Indexer` (reverse value→entities) for the ~30 components flagged
`indexed: true` in `deploy.json`. Queries:
`runQuery([HasValue(...), Has(...)])`. Stat components decode to
`{base, shift, boost, sync}`. State size: order 10⁵–10⁶ entries.

## 3. Derived-state layer

All live values = pure functions of (last synced state) +
(now − on-chain timestamps) + (on-chain config).

Formulas:
- `app/cache/harvest/calcs.ts` — `calcIdleTime`, `calcBounty` /
  `calcNetBounty` / `calcRawNetBounty` (musu accrued =
  `floor(idleTime × rate)`, rate = `boost × (fertility +
  intensity)`), `calcFertility` (`(power × ratio × efficacy)/3600`),
  `calcIntensity` (minute-granular ramp), efficacy/affinity matchups.
- `app/cache/kami/calcs/base.ts` — **`calcHealth`** (HARVESTING:
  `syncHP − strain(cappedRawNetBounty)` — drain follows musu earned,
  not time; RESTING: `syncHP + calcRestingHealthRate × idleTime`;
  clamped), `calcRestingHealthRate`
  (`((harmony + nudge) × ratio × boost)/3600`), **`calcHealTime`**
  (`(totalHP − syncHP)/healthRate − idleTime`), **`calcCooldown`**
  (`time.cooldown − now`; NextTime is an absolute end-timestamp),
  `onCooldown`, `isStarving`, `isFull`, `canHarvest`.
- `app/cache/kami/calcs/harvest.ts` — `calcHarvestingHealthRate`
  (HP drain = −strain(spot rate)), `calcOutput` (displayed musu =
  balance + capped raw bounty), `calcMaxMusu` (HP budget → max
  earnable musu).
- `app/cache/kami/calcs/liquidation.ts` — kill-threshold / salvage /
  karma math.

Inputs, all on-chain via the mirror:
- Timestamps: `network/shapes/Kami/times.ts` (`{cooldown: NextTime,
  last: LastTime, start: StartTime}`), harvest `{last, reset,
  start}`.
- Stats: `network/shapes/Stats.ts` — total = `(1+boost)(base+shift)`;
  `sync` = last synced depletable value.
- **Config**: `network/shapes/Kami/configs.ts` reads every constant
  from on-chain config entities: entity =
  `keccak256('is.config', <FIELD>)`, value = packed 8×uint32,
  unpacked to `{nudge, ratio, shift, boost}` fixed-point nodes.
  Fields: `KAMI_HARV_BOUNTY/FERTILITY/INTENSITY/STRAIN/
  EFFICACY_BODY/EFFICACY_HAND`, `KAMI_REST_METABOLISM`,
  `KAMI_STANDARD_COOLDOWN`, `KAMI_LIQ_*`. The contracts read the
  same arrays (`LibKami.sol` via `LibConfig`) — **a port that reads
  configs the same way stays correct across balance patches.**
- Bonuses (skills/items/traits): on-chain Bonus entities
  (`network/shapes/Bonus`), applied as boost/shift deltas.

Caveats: `calcCooldownRequirement` hardcodes a `180` fallback;
calcs use wall-clock `Date.now()` — a headless port should
offset-correct against stream `blockTimestamp`.

## 4. Headless feasibility

### Port (recommended)
React lives only under `src/app/components|root|boot`; sync/state/
derived layers are plain TS + rxjs + mobx + ethers. Exhaustive
browser-bound list (verified by grep) — 7 swap points:

1. `network/setup/configs/configs.ts` — `import.meta.env` /
   `window.location`; already supports a private-key signer.
2. `workers/create.ts` — `new Worker(...)` → in-process /
   `worker_threads`.
3. `cache/db.ts` + `workers/sync/state/store.ts` — IndexedDB →
   SQLite / file snapshot (8 object stores).
4. `workers/sync/grpcTransport.ts` — browser gRPC-web transport →
   Node transport (protos are already nice-grpc definitions).
5. `workers/visibility.ts` — tab-visibility signals → delete.
6. `engine/recs/Component.ts` — one React hook → strip.
7. Vite path aliases → tsconfig/tsup.

Everything else lifts: sync worker, recs mirror, shapes, calc layer.

### Stateless mode (degraded fallback only)
Deterministic entity IDs make single-entity reads possible without
sync: config = `keccak('is.config', field)`; kami =
`keccak('kami.id', uint32)`; harvest = `keccak('harvest', kamiID)`
(`LibHarvest.sol` `genID`); inventory slot =
`keccak('inventory.instance', holderID, itemIndex)`; node =
`keccak('node', uint32)`. Plus free `GetterSystem` views
(`getKami`, `getKamiByIndex`, `getAccount` — account stamina is
projected on-chain; kami HP is not). ~30 full components support
`getEntitiesWithValue` on-chain (`IDOwns*`/`Id*`, `Name`,
`OwnerAddress`, `OperatorAddress`, `Location`, `TokenHolder`…).

**Limit**: ~65/95 components are `Bare*` (reverse lookup reverts),
including `State`, `EntityType`, `IdSource` (harvest→node),
`IndexRoom`, `IndexKami`, all Stat/Time/Value. The client answers
"who's on node X" with `runQuery([HasValue(SourceID, nodeID),
HasValue(State,'ACTIVE'), HasValue(EntityType,'HARVEST')])` over the
local mirror (`network/shapes/Node/harvests.ts`) — there is no
on-chain equivalent. Discovery queries require the mirror.

## 5. Perception inventory (coverage checklist)

From `app/stores/visibility.ts` (`Modals`/`Fixtures`) +
`app/components/fixtures/` + `app/components/modals/`:

**Fixtures (always-on HUD)**: header/clock (day/night phases), menu,
notifications, action queue (local tx queue).

**Modals** → data:

| Modal | Data source |
|---|---|
| `party` | own kamis: live HP (calcHealth), state, cooldown, harvest output |
| `kami` | single-kami sheet: stats/traits/skills/equipment/battles (`shapes/Kami/*`, `shapes/Skill`, kamiden `GetBattles`) |
| `node` | occupants via `shapes/Node/harvests.ts` (mirror query); ally/enemy cards with calcOutput/calcHealth/liquidation threat; scavenge (`shapes/Scavenge`) |
| `map` | `shapes/Room`, `shapes/Portal`, `constants/rooms` |
| `inventory` | `shapes/Inventory` (`IDOwnsInventory` + item balances) |
| `chat` | Kamiden `GetRoomMessages` + stream |
| `crafting` | `shapes/Recipe` |
| `merchant` | `shapes/Npc`, `shapes/Listing` |
| `marketplace` | KamiSwap: kamiden `GetKamiMarketListings/Bids/History` + `shapes/Listing` |
| `trading` | `shapes/Trade` + kamiden `GetTradeHistory`/`GetOpenOffers` |
| `quests` | `shapes/Quest` + `shapes/Conditional` requirement evaluation |
| `goal` | `shapes/Goals` |
| `leaderboard` | `shapes/Score` + kamiden rankings |
| `gacha`/`reveal` | `shapes/Gacha`, `shapes/Commit`; block-driven commit-reveal |
| `account` | `shapes/Account` (stamina, room, friends `shapes/Friendship`, reputation `shapes/Faction`) |
| bridges | wagmi/Initia + kamiden `GetTokenDeposits/Withdrawals` |
| misc (`kamiSend`, `naming`, `templeOfTheWheel`, `lootBox`, `dialogue`, …) | kami transfer/naming/sacrifice (`shapes/Sacrifice`), NPC dialogue |

Not modal-bound but player-visible: battle/kill feed (kamiden stream),
room presence of other accounts (`RoomIndex == here`, mirror query),
sync/loading state (`component.LoadingState`).

## 6. Errata — re-verified 2026-07-20 (fresh clone @ `ef898fc9`)

Corrections and sharpenings from a claim-by-claim re-derivation, plus
live measurements against the public Yominet RPC. DESIGN.md builds on
the corrected values.

- **Component split is exactly 64 Bare / 31 full** — counted from the
  Solidity sources (`packages/contracts/src/components/*.sol`,
  extending `BareComponent` vs `Component`); `deploy.json` carries no
  bare/full flag, only the 95-entry registration list (with
  `indexed: true` on exactly 30). "~65/95" above is off by one.
- **Swap point 1 (env config) is wider**: `import.meta.env` is also
  read directly in `clients/kamigaze/client.ts`,
  `clients/kamiden/client.ts`, and `clients/kamiden/txErrorLogger.ts`.
- **Swap point 6 is wider**: `engine/recs/Component.ts` also contains
  localStorage-based `createLocalCache`/`clearLocalCache` — dead code
  (no callers), stripped together with the React hook.
- **§2 "full state is reconstructible from logs alone" holds for the
  protocol, not the public endpoint.** Measured 2026-07-20: the
  public Yominet RPC retains World logs only for the trailing
  ~1.02 M blocks (~25 days at ~2.1 s/block); older ranges — including
  the deploy block — return empty results with HTTP 200, not errors.
  Pure-RPC bootstrap from block 44,577 is therefore impossible there.
  The no-snapshot code path is real but is, in practice, the
  local-dev path (`getLocalConfig`: localhost chain, block 0);
  production config always sets the Kamigaze URL. Related: the sync
  worker never reads `initialBlockNumber` — with a fresh cache it
  gap-fills from block 0 — and in no-stream mode `fillGap` receives
  an undefined Kamigaze URL, working only via its error path.
- **There is no Kamigaze→RPC degradation at bootstrap**: a snapshot
  failure is terminal (`SyncState.FAILED`); `isRateLimited` (gRPC
  code 8, or 403 from `GET /healthy`) only selects the error message.
- **The state cache is persisted exactly once per session**
  (post-backfill, pre-stream); nothing checkpoints during live
  operation.
- **§3 "dependencies: recs + lodash only" understates**: `app/cache`
  also imports ethers, `@stdlib/stats-base-dists-normal-cdf`,
  `constants/**`, and `clients/kamiden` (`app/cache/chat`); and
  `network/shapes` / `network/explorer` import `app/cache` back
  (circular layering — shapes and app/cache port as one unit).
- **Confirmed exactly as stated**: config-entity hashing and 8×uint32
  unpacking vs `LibConfig`/`LibPack` (bit-identical); the Kamigaze
  method set; Kamiden = 15 unary methods + `SubscribeToStream`; the
  chat pane reads only `GetRoomMessages` + the stream; deterministic
  ID formulas and `GetterSystem` getters; the 180 s cooldown fallback
  (`app/cache/kami/calcs/base.ts:95`); the production endpoint
  values.
- **Port hazards**: `componentIDs.json` is not strict JSON (trailing
  comma); `workers/sync/snapshot/fetch.ts` contains a dead
  `maybeThrow()` test helper (throws with probability 0.6);
  the snapshot health check uses browser-only fetch `mode: 'cors'`;
  the Kamiden client starts its perennial stream as a side effect of
  the first `getClient()` (module singleton, 5 s reconnect loop);
  stream `blockTimestamp` is uint32 seconds while Kamiden timestamps
  are milliseconds.

### Second pass — design session 2 (2026-07-20, same pinned clone)

Corrections from the untrusted-strings/Kamiden verification sweep. One
bullet above is itself corrected here — errata to the errata, flagged
rather than silently rewritten.

- **"Kamiden = 15 unary methods" above is wrong**: the pinned
  `clients/kamiden/proto.ts` defines **22 unary methods** plus
  `SubscribeToStream`. Call-site grep says the client uses 13
  (`GetRoomMessages`; `GetBattles`/`GetBattleStats`;
  `GetTradeHistory`/`GetOpenOffers`;
  `GetKamiMarketListings`/`GetKamiMarketBids`/`GetKamiMarketHistory`;
  `GetTokenDeposits`/`GetTokenWithdrawals`/`GetOpenWithdrawals`;
  `GetItemTransfers`; `GetAuctionBuys`); nine are uncalled —
  `GetHarvestRanking`/`GetKillerRanking` (the only methods with an
  `ApiKey` request field) and seven per-entity stat getters
  (`Get{Kills,Deaths,Musu,Movements}ByAccount`,
  `Get{Kills,Deaths,PNL}ByKami`).
- **The leaderboard modal is chain-only at this pin**: it reads
  `shapes/Score` + `constants/leaderboards`; "kamiden rankings" in §5
  refers to RPCs the client never calls.
- **Kamiden dependencies hidden inside chain-sourced surfaces**: the
  inventory modal's transfer-history tab (`GetItemTransfers`), the
  gacha auction price chart (`GetAuctionBuys`), and notification
  production (droptable/sacrifice reveals arrive via
  `DTRevealerSystem`'s feed subscription).
- **Player-authored string surface, measured in the contracts**:
  account name ≤16 bytes, non-empty, unique
  (`AccountRegisterSystem`/`AccountSetNameSystem`); kami name ≤16
  bytes, non-empty, unique (`KamiNameSystem`; `KamiOnyxRenameSystem`
  is on-chain-disabled, same cap); account bio ≤140 bytes of free
  text (`AccountSetBioSystem`), read back through `shapes/Account`
  (friend/request/blocked cards); chat has **no on-chain length
  cap** — `ChatSystem` accepts an arbitrary string and forwards to
  the Emitter (`LibEmitter.emitMessage`); the 200-char limit is a
  client-side input `maxLength` only. Received chat is unbounded
  adversarial input. `AccountSetPFPSystem` is not a text path (it
  copies an owned kami's `MediaURI` by ID).
- **Chat transits the chain**: a message is a `ChatSystem` transaction
  emitting an Emitter event — never component state; Kamiden indexes
  the events and is the only queryable store. ("Chat exists only in
  Kamiden" holds for storage, not transport.)
- **Kamiden payloads carry almost no player-authored text**: every
  feed/trade/market/portal/battle message is IDs, indices, amounts,
  timestamps, booleans. Player text appears only in `Message.Message`
  (chat) and in name fields of the client-unused ranking/leaderboard
  responses (`RankRow`, `LeaderboardRow`). Names shown in feeds and
  markets come from consumer-side joins against the mirror's `Name`
  component.
- **§5's modal list has gaps**: `visibility.ts` + the modals directory
  also contain `obol`, `presale`, `studio` (AnimationStudio),
  `kamiPortal`, `kamiAdoptionAgency`, `operatorFund`/`FundOperator`,
  `help`, `settings`, `questDialogue`, `bridgeERC20`/`bridgeERC721`.
  `emaBoard` is the naming modal's UI, not a separate surface; the
  `lootBox` modal key exists in `visibility.ts` with no dedicated
  `modals/lootBox` directory. Coverage now carries the enumeration.
- **Notifications verified**: a client-local recs component, never
  chain state; producers are quest-completability checks and Kamiden
  reveal events; contents are registry text (item names, quest
  titles), not player-authored.
- **`StreamRequest` supports topic filtering** (`topics: string[]`,
  empty = all) — a daemon subscription can exclude chat at the
  transport level.
