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
