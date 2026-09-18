# kami-lens — Design

Status: **v1 — settled** (2026-07-20; untrusted-text policy §3.10 and
Kamiden scope settled in design session 2, same date; §3.7
parity-reference standard amended 2026-07-21; §3.1/§3.2 gap-recovery
inverted and §3.17 added 2026-09-06; §3.8 clock fields renamed and §3.15
freshness paragraph added 2026-09-06; §3.1 state-CDN cold boot and §4.1
bridge added 2026-09-17, describes 0.6.2). Evidence base:
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
- Kamigaze `SubscribeToStream` for push; **gaps healed from the chain**
  (`eth_getLogs` on the World contract), with Kamigaze `GetEventsSince`
  reserved for bootstrap and for gaps wider than `GAP_RPC_MAX_BLOCKS`,
  followed by a chain top-up of the head. This is an INVERSION of what
  this line said until 0.6.0 ("gaps healed by `GetEventsSince`, with RPC
  `eth_getLogs` replay as fallback"), and it is deliberate; the argument
  and the measurements are §3.17 (dated 2026-09-06).
- Pure-RPC event replay (`ComponentValueSet` /
  `ComponentValueRemoved` World logs) is used exactly where the web
  client uses it: gap-fill over recent blocks, and dev/local chains.
  It is **not** a production bootstrap path: the public RPC retains
  logs only for a trailing window (§4.1), so replay from the world
  deploy block is impossible there. The web client never faces this
  because its production config always sets the Kamigaze URL; its
  no-snapshot code path is exercised only against short local dev
  chains, where replay-from-genesis is cheap and complete.
- **A cold boot streams the full image from the state CDN first
  (0.6.2), and falls back to the gRPC path above.** The bullet at the
  top of this section describes what a cold start COSTS, and the cost
  was the problem: one gRPC `GetState` stream carrying the whole ECS
  image, which failed five times running on the VM on 2026-09-12 —
  `UNKNOWN: Response closed without headers` at "Querying for State",
  the 90-s pre-LIVE watchdog (§3.2) cutting each retry ladder, every
  attempt restarting from block 0. The only cold start that worked
  afterwards was copying a 230 MB checkpoint file between machines by
  hand, which is not a procedure. Upstream moved the image off the
  snapshot service: an exporter writes it to S3 behind CloudFront
  (`state.prod.kamigotchi.io`) every ~2 h with a 2-day object expiry,
  and the deployed web client cold-boots from it in parallel chunks.
  kami-lens does the same, with the CDN **on by default** (§5
  zero-config: a fresh machine should take the fast path without being
  told to). The shape:
  - `latest.json` names the export — nonce, block, key prefix, and the
    number of values and entities chunks. It is fetched on a tight
    budget, because a stalled read here is dead time in front of the
    fallback, and it is REFUSED unless the prefix is non-empty and
    every count is a positive integer. A zero count is the dangerous
    shape and the reason the validation exists: it would fetch
    nothing, raise no 404, and still finalise the cache at
    `manifest.block` — a mirror silently missing everything below a
    block it claims.
  - The manifest's nonce must equal the nonce a live `GetStateBlock`
    reports, checked before a byte of state is fetched. The manifest
    is up to one export interval old, so after a reindex it still
    names the previous nonce while its indices are dead.
  - Components land FIRST (values decode against them), then values
    and entities in parallel with a bounded number of chunks in
    flight; entities strictly in index order, because the cache only
    appends at the tail.
  - **Everything else takes the gRPC path, and that is the contract**:
    an unreadable or malformed manifest, a nonce disagreement, a cache
    warm enough to serve a delta, any chunk failure, and a chunk set
    that aged out of the bucket while `latest.json` survived (404 or
    403 — never retried; the manifest is re-read ONCE in case the
    exporter simply moved on, and a manifest still naming the same
    block is a real failure). Switching `stateCdnUrl` off is the same
    path unconditionally.
  - Nothing is believed about the world that Kamigaze does not also
    say. It is the same image by a cheaper route, stamped at the same
    nonce, and `status.lastFullLoad` records which route was taken,
    with the export prefix — because "which image is this daemon
    holding" must be answerable without grepping a log.
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

**A bounded retry schedule is only a bound on the failures it can see
(0.5.2).** The schedule above fires on the worker's terminal errors, and
that is the whole of what reaches it: the daemon learns about failure
through one channel, the LoadingState component. So a bootstrap that
neither succeeds nor fails is invisible to it, and 0.5.1 had exactly such a
state. A daemon restarted on laptop wake, before the network was back, built
an ethers `WebSocketProvider` whose socket never opened. That provider never
reconnects (its reconnect handler is commented out upstream of us) and the
readiness promise its `getBlockNumber()` awaits is resolved only by the
socket's `onopen` — so the call **never settles, neither resolving nor
rejecting**. Measured: the JSON provider rejects on `ENOTFOUND` in 17 ms; the
WebSocket one is still unsettled after 20 s, and after the network returns,
forever. `ensureNetworkIsUp` waits on both through `Promise.all`, two nested
retry ladders waited on that, and the daemon sat in `SETUP` / "Starting State
Sync" / 0% for 8+ minutes with its socket open, answering every world read
`NOT_FOUND ... not in mirror`, while `headBlockNumber` advanced in its own
status output and proved the network was back. A kickstart fixed it in 15 s.

Two changes, and the second is the one that generalizes:

- **The hole is closed at its source.** Each network probe is bounded
  (`NETWORK_CHECK_TIMEOUT_MS`, 10 s — the same budget the keepalive loop
  beside it already used), so the ladder advances and its next attempt
  builds a *fresh* provider pair, which is what actually recovers. A failed
  attempt now also destroys the pair it built, which nothing did before.
- **And a bound is added that does not depend on having found the right
  await.** While pre-LIVE, if neither the sync percentage, the sync message,
  nor the live block number changes for `PRELIVE_STALL_MS` (90 s), the
  daemon tears the worker down and re-bootstraps **through the same
  `onFailed` path a worker failure takes** — counted as an attempt, and
  exhausting the schedule still rejects loudly. One retry path, not two.
  Ninety seconds is chosen against the phases: every pre-LIVE phase ticks a
  percentage or changes its message far faster, and the one phase that
  legitimately goes quiet, saving the state cache, was measured at 3.7 s for
  2.96 M entries. The stall is surfaced in `degraded` as
  `pre-live-stall:<N>s` — chain health, so it belongs there beside
  `stream-stalled` — and the lab's external watchdog restarting a non-LIVE
  daemon after three minutes is the outer bound to this inner one.

The general form: **the retry schedule bounds failures; something else has
to bound silence.** A daemon cannot assume that everything which goes wrong
will announce itself, and every await on the bootstrap path was trusted to.

**A retry ladder that never resets is a constant delay (0.6.0).** Upstream's
stream reconnect climbs a fixed ladder — 1, 2, 3, 5, 10 s, capped — and its
counter is reset by the only thing that resets anything in a browser tab: a
reload. A daemon has no reload. Measured over the 2026-08-26 → 09-06 daemon
log: 17,369 reconnects in eleven days, about one every 55 s, because the
production server closes the subscription every ~30-40 s by design. So from
the sixth reconnect of the process onward, every single reconnect paid the
capped 10 s, forever. `retry({ resetOnSuccess: true })` makes the ladder mean
what it reads as.

The same log holds the second half. 57 of its 59 gap-fill failures are
`RESOURCE_EXHAUSTED: rate limit exceeded, retry in N s` — the server saying
exactly how long to wait — and answering that with a 1 s ladder step spends
the budget the limit exists to protect. A rate-limit error's own suggestion is
now honoured, rounded up and capped at 30 s. Both paths log at **WARN with the
delay chosen**; the old ladder logged at DEBUG, and the daemon runs at INFO,
which is why none of this was visible while it was happening.

**Kamiden feed health has its own gate (0.5.2).** `degraded` stays
CHAIN-only — a Kamiden outage must never stamp a chain answer stale, which
is the soft-dependency clause above — but nine reads are Kamiden-backed and
a session protocol that opens on `status` and gates every later read on
`degraded` alone was reading a healthy-looking daemon while the feed
flapped (observed 2026-08-27: stream `retrying`, 16 reconnects in 13
minutes, `degraded: []`, `meta.stale: false`). `status.feedsDegraded` is the
counterpart array, shaped the same so a caller gates on it the same way, and
separate so the doctrine survives. It reads `kamiden-stream:<state>`
whenever the stream is not live and `kamiden-silent:<N>s` past 60 s. It is
deliberately NOT keyed on the reconnect count: the production server closes
the subscription roughly every 40 s by design (measured 2026-07-21 at gate
G4.b, re-measured 2026-08-27 at one close per 49 s on a stream reporting
`live` with zero consecutive failures), so a rising `retries` is this feed's
healthy resting state and the error text it logs
("Response closed without grpc-status (Headers only)") is expected, not an
upstream change.

### 3.3 Projection ported, not re-derived

Lift the client's calc layer (`calcHealth`, `calcBounty`,
`calcOutput`, `calcCooldown`, `calcHealTime`, liquidation math) and
shapes as-is. Constants come from on-chain `is.config` entities —
verified bit-identical between the client reader and `LibConfig`
(same `keccak256(abi.encodePacked('is.config', field))` entity ID,
same 8×uint32 unpack order) — so balance patches that only change
config values require no kami-lens change. Exceptions ship in client
code, with the pin: e.g. the hardcoded 180 s cooldown fallback.
*(Corrected at 0.5.0: earlier text named the map's room data
(`constants/rooms`) as a second example. It is not one — that module was
never ported, and this layer reads room identity, description and location
from the mirror's own components. The claim described upstream, not the
port.)* These are tracked per release
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
cheap to revise. From 0.6.2 it is disposable in practice as well as in
principle: a cold checkpoint is no longer a file someone copies between
machines by hand, because §3.1's CDN path rebuilds one in a single
parallel fetch. SQLite (`node:sqlite`) is the named upgrade if
checkpoint cost bites (§6); `v8.serialize`'s Node-version coupling is
acceptable for a disposable cache.

**The checkpoint runs OFF THE MAIN THREAD (0.6.3, divergence 16).**
`v8.serialize` is synchronous, so writing a ~230 MB cache holds the one
thread that also owns the query socket and every timer — and the
checkpoint deserializes the stored cache synchronously before its delta.
Measured on the VM (2026-09-18): **the daemon does not answer `status`
for 20-32 s every ten minutes** (4-5 s on the Mac). That breaks the
promise this document and `server.ts` both make — `status` is the one
query that must always answer — and it is worse than a broken promise,
because the VM watchdog reads "no status answer from a running unit" as a
dead unit and restarts it, landing the SIGTERM in the middle of the
write. The health check manufactured the outage it was watching for
(L-8/L-10 class).

The refresh is movable for one reason, stated here because everything
below depends on it: **it never touches the live mirror.** It reads the
STORED cache off disk, deltas it, and writes it back; the recs world and
the live stream are a different object, and live events are never folded
into the persisted cache (the checkpoint model above). So the whole of it
— deserialize, delta, serialize, commit — runs in a forked child
(`src/checkpoint-child.ts`, `src/workers/checkpoint/`) with its own heap
cap, and the main thread gets a small `CheckpointReport`.

*A child process rather than a worker thread,* and that is a measured
choice rather than a preference. The port's file bodies are upstream's,
which means they import through the tsconfig `paths` aliases (swap point
7, §4.1). tsx resolves those on a main thread and **does not** resolve
them inside a `worker_threads` Worker — measured four ways on 2026-09-18,
each failing `Cannot find package 'utils' imported from …/src/<worker>.ts`
while the identical import resolves on a main thread and in a forked
child; vitest is the same story by a different route, since
`vite-tsconfig-paths` rewrites what Vite transforms and a raw
`new Worker('…/x.ts')` is not that. A worker checkpoint would therefore
only ever have worked against `dist/`, so every gate that builds a daemon
from source — G1.a, G10.a, G10.e, and this release's own hermetic tests —
would have exercised a different code path than production, and the first
proof of the real one would have been a live VM. The child also isolates
the ~2.5 GB of deserialize-plus-serialize into its own address space
rather than carving it out of the daemon's heap cap, and a child that dies
takes one checkpoint with it and nothing else. The cost is one Node start
(~150 ms) every ten minutes.

*Shutdown protocol.* **The commit ORDER is the crash safety, not the
waiting:** temp file → fsync → rotate the primary to `.prev` → atomic
rename. At every instant there is a valid primary or a valid `.prev` and
never neither — before the rotation the old primary is intact, between the
two renames the primary is missing and `.prev` is the old one, after them
both are good — which is what the two-candidate read at boot relies on.
A kill is therefore safe wherever it lands. What the protocol adds is only
that a *completed* delta is not thrown away: on `stop()` an in-flight
checkpoint is DRAINED rather than raced (starting a second writer beside
it is how two writers end up in one file), the child signals when it is
about to save, and the drain is bounded — ordinary grace, then one extra
window if the save has begun, then a kill **by that child's PID**. A
checkpoint that is killed before its commit costs one interval and
nothing else. `status.checkpoint.inFlight` says when one is running, and
is answerable at all only because the write moved: before 0.6.3 a `status`
asked during a checkpoint did not come back.

The other two save call sites do NOT move, for reasons that are about
where the data lives. The bootstrap's own save ("Saving State Cache",
`Worker.ts`) serializes the LIVE initial state, which is in the main
thread's heap — shipping it across a process boundary is a full copy of
the thing whose copy is the expense. It is pre-LIVE, so no reader is being
starved of `status` answers it would have acted on, and the pre-LIVE stall
bound already accounts for that phase by name. `FileStateStore.set/flush`
is reached only through those two save sites, so it is unchanged, and the
child reaches exactly the same commit code — the on-disk contract is one
implementation, not two.

### 3.6 Interface: on-demand pull, JSON out

No ambient push. The lens never alters what the world contains; it
only chooses what it volunteers (§3.10). Query tools are general (any operator/account/node
as argument). Consumers that want a session-start briefing simply run
the own-operator report themselves — it is the same general tool, not
a special path.

### 3.7 History boundary: community-standard parity

Kamiden in-session feeds (kill feed, recent trades, market history)
are inside the target; longitudinal reconstruction is not. The chat
pane is inside the target, served under the untrusted-text policy
(§3.10).

**Parity-reference amendment (2026-07-21; wording revised same day).**
The parity reference standard is the **community-standard
environment**: the official web client plus widely-used community
tooling (the account/room-tracker class) — not the web client alone.
Specific tool precedents are cited in the record that owns this
decision; the public principle stands on "widely-used community
tooling" alone. This section's earlier "web-client parity"
phrasing for sync/history is superseded accordingly. Consumers get
general full-view read tools — any inventory, any room, other
players — the visibility the community environment already grants;
oracle/investigator-grade analytics stay out (non-goals §2
unchanged). Each exposure class cites its community-tool precedent;
exposure specifics land at the next harness design pass. Gate G2.b
and the M2 scope are unchanged: display parity is still measured
against the official client.

### 3.8 Clock discipline

Projection uses stream `blockTimestamp` offset-correction, not naive
wall clock (the web client uses `Date.now()`; a daemon must not
assume a synced clock). Unit care: stream `blockTimestamp` is uint32
**seconds**; Kamiden timestamps are **milliseconds**. Operatively at
the pin: the Kamigaze stream's `blockTimestamp` arrives as 0 (the
server never populates it), so the offset anchors on RPC-fetched
header timestamps of blocks the stream has delivered — the stream tap
stays armed, and a populated field would simply win as the fresher
observation.

**What the offset actually measures, and it is not what the name says
(0.5.2, measured).** The anchor is *a block the stream has delivered*, so the
correction absorbs the Kamigaze pipeline's end-to-end lag along with any
wall-clock skew, and at this pin the lag dominates. Measured live
2026-08-27 against an independent `eth_getBlockByNumber("latest")`, on a
machine whose wall clock was correct to 1–2 s: **`clock.now()` ran 14.2–15.3
s behind chain head time** across four consecutive samples. Three
consecutive observations gave offsets of −7 660 ms, −17 372 ms and −16 585
ms, so **the correction stepped 9.7 s between two of them — which
`clock.now()` takes as a jump backwards. now() is not monotonic.** The
cadence is 300 s and the offset was observed ageing to 279.5 s before
refreshing.

Three ways it gets worse, none of which any surface reported before this
release:

- Before the first stream event there is no observation at all
  (`syncClock` returns early on a zero live block), so the offset is 0 —
  because nothing was measured, not because the clocks agree.
- `getBlock()` returning null on a lagging load-balanced backend, or
  throwing, means no observation that tick: the offset silently ages another
  300 s behind a `log.warn`.
- **Across a stream gap the clock stops.** `liveBlockNumber` freezes, so
  every subsequent tick re-observes the *same* block timestamp against a
  later `Date.now()`; the offset walks negative one-for-one with elapsed
  time and `clock.now()` is re-pinned to the frozen block's timestamp. The
  observation *succeeded*, so `clockLastSyncWallMs` keeps advancing and
  nothing looks wrong.

**0.5.2 does not change the projection. It exposes the inputs.** Changing
the correction would move every projected value in the surface, and those
values are parity-gated against the reference client (G2.b) — the release
that measures a thing is not the release that acts on it (§3.15's rule,
applied again). What ships instead is `meta.asOf`, on every envelope, in the
one place every answer passes through:

    asOf: { block, projectedAtSec, clockSampleBlock, clockSampleBlockTime,
            clockOffsetMs, clockSampleAgoMs }

The fields are kept **separate and unfused on purpose**. `block` is the
mirror's lower bound (§3.15); `projectedAtSec` is the instant the projection
math actually used; `clockSampleBlock` / `clockSampleBlockTime` are the
*different, older* block whose header produced the current correction, and
`clockSampleAgoMs` says how stale that is. Pairing a mirror block with a clock
anchored on another block, as one "as of" claim, would be a lie of
convenience. The last four are **absent together** until the first
observation, on the §3.15 head-fields precedent: a served `clockOffsetMs: 0`
would read as a measurement.

**What the clock sample is, and what it is not (0.6.1 — the rename).** It is
the block whose header timestamp last calibrated the offset-corrected clock,
refreshed every `CLOCK_SYNC_INTERVAL_MS` = 300 s (`src/daemon.ts` `syncClock`).
So `clockSampleAgoMs` **cycles 0–300 s on a perfectly healthy mirror**, and a
value near 300 s means the next sync is due — not that anything is late. It is
**not mirror lag**, it is not the age of the answer, and it says nothing
whatever about applied state. Mirror lag is `status.blockLag`
(`headBlockNumber − meta.blockNumber`); verified applied state is
`meta.reconciledThrough` (§3.15).

These fields were called `observedBlock` / `observedBlockTime` /
`observedAgoMs` from 0.5.2 to 0.6.0, and a consumer read them as mirror lag
**twice** — hybrid-play ledger row L-2 on 2026-08-29, then again at the 0.6.0
sync on 2026-09-06 — gating live play decisions on a number that was doing
exactly its job, and filing a lens defect against it. The paragraph above
said so, in this document and in `src/queries/envelope.ts`, the whole time.
That is the lesson worth keeping: **a doc comment loses to a field name.**
"Observed" invited the reading, because the mirror also observes things. So
0.6.1 renames rather than re-explains, and the old names ship one more
release carrying identical values (SPEC §1.4) before they are removed at
0.7.0.

`cooldownUntil` follows from the same reasoning at the field level: the raw
on-chain cooldown end time, served beside the projected `cooldownSec`, so a
caller can compare against a block timestamp it trusts rather than against
this daemon's clock. Its zero is load-bearing and documented — the ported
getter reads an absent `NextTime` component as `0`, so `0` means the mirror
holds no cooldown for that kami, never "ready now".

**`attacker.blocked` (0.5.3)** is the same move once more: the attacker's own
liquidation gate, stated as a field instead of left to be inferred. On a node
answer given an attacker it reads `null`, `ATTACKER_STARVING` or
`ATTACKER_COOLDOWN`, in that precedence — the same function that produces a
row's `liquidation.reason`, so the two can never disagree. It is present
whenever the attacker argument is given, with or without `--eligible-only`.
Before it, the fact was reachable only by reading every row's `reason` or —
worse — by inferring it from an empty filtered list, which is also what an
empty node looks like (§3.13). A caller must never have to distinguish "my
kami is busy" from "there is nothing here" by the LENGTH of a list.

**A note on a symptom this does NOT explain.** A caller reported
`cooldownSec: 0` up to ~10 s before the chain agreed, and attributed it to
the offset. The sign runs the other way: with `clock.now()` in the past,
`calcCooldown` **over**-reports the remaining cooldown, so the lens says
"still on cooldown" after the chain has released it — the safe direction.
The likelier mechanism is mirror lag on the `NextTime` component itself,
where an absent or not-yet-synced value reads as `0` and the cooldown
vanishes rather than being over-stated. That is a hypothesis, not a
finding — it could not be reproduced from the reported instant — and
`cooldownUntil` beside `asOf` is what makes the next occurrence
distinguishable instead of arguable.

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

### 3.11 What a reader must be able to read before it acts (0.3)

Settled with the 0.3 surface additions. **A failure must never cite state
the reader could not have read through the query surface beforehand.**

An action refused because of some condition — a purchase rejected because
the item was not on offer this cycle, an objective that turns out not to
have been counting what it appeared to be counting — is only fair to the
reader if that condition was readable in advance. Where it was not, the
gap is a defect in this surface rather than an inconvenience of the world:
the reader is being asked to discover state by failing, and a machine
reader will simply fail again.

Two consequences that are easy to get backwards:

- **A missing pane is not a missing surface.** That the reference client
  displays something is good evidence that it matters and is worth
  serving. That the reference client does *not* display something is no
  evidence at all that it should be withheld. Panes are one product's
  editorial choices; this is a query surface, and the two are not the same
  object. Where the world holds a fact a reader needs before acting,
  serving it is in scope even if no pane shows it. (§3.7's parity standard
  is unchanged: it fixes the *ceiling* of exposure. This fixes the floor.)
- **Serving a truth surface is not mirroring a pane.** Where a pane and
  the state beneath it disagree, the state wins and the disagreement gets
  documented. The case that settled this: the reference client's
  quest-detail panel can render an accrual objective as already satisfied
  for a quest the account has not accepted — accrual is measured from a
  snapshot taken at acceptance, and with no snapshot yet written the
  comparison runs against zero, so a lifetime total reads as progress. The
  client's own accepted-quest counter contradicts it the moment the quest
  is taken. Copying that checkmark would be mirroring a pane; refusing to
  serve progress before acceptance is serving the truth surface.

**Predictions ride with the change.** Every 0.3 addition carries a
falsifiable statement of the behaviour it should produce, recorded beside
the change and checked by a gate. A claim that cannot fail is not a claim,
and a surface addition whose value is asserted rather than demonstrated is
how a query surface accumulates fields nobody can rely on.

**One consequence for pin semantics, stated rather than left implicit.**
Item pools are world state that arrived after the pinned client. Their
rows are therefore served with no lineage to the pin at all: no ported
module implements them, and no display-parity comparison is even possible
because the pinned client has no pool pane to compare against. Part of the
served surface is now pin-dated (code lineage, §7) and part is world-dated
(state that exists whether or not the pinned client knows about it). That
is deliberate and follows directly from the principle above, but it must
be visible: the coverage row says so, and quoting — as opposed to serving
pool facts — is deferred to §6 precisely because it is the part that would
need the code lineage.

### 3.12 Payload enrichment — the tooltip facts, inline (0.4)

Settled with the 0.4.0 surface. **Where a result names an item or a room and
says nothing else about it, the reader is one lookup short of a decision it
could have made from the same answer.**

A human client shows a tooltip on hover: hold a Ramen Bowl and the interface
tells you it restores health, that using it needs the kami resting, and what
the quest you are on pays. A machine reader got the name and the balance and
had to know, in advance, that a second read existed and was worth making.
Runs of the reference agent showed the predictable outcome — items held
unused, experience unspent, rewards unread — not because the facts were
secret but because they were one path-guess away.

So the facts move to where they are read. `inventory` rows and merchant
listings carry the item's description, what USE and EQUIP allocate, and what
USE requires; `item`/`items` carry the same plus the stored registry flags;
quest registry rows carry their rewards; a bare `roomIndex` on `account`,
`node` and `roster` resolves to the room; an `ItemRef` on a decision surface
carries the item's description.

Four constraints make it safe to do:

- **Chain or deployed config only.** Descriptions come from the mirror's
  `Description` components, effects from the item's own Allo registry,
  requirements from its Conditional registry, rewards from the quest's
  reward Allos. Nothing is read from a document, a catalog, or a
  lab-authored file: the lens ships what the world holds, and knowledge
  that lives in prose stays the consumer's own business (the scaffold's, for
  an agent).
- **Results only, behind a daemon flag.** No new query, no new request
  field, no schema field that moves or changes type. `enrich` is config —
  one daemon serves one surface, and a caller cannot ask for a different
  one. Default off, and off is **byte-identical to 0.3.0** (G3.g proves it
  leaf by leaf against a pre-change baseline) with one named exception:
  `status` gains `config.enrich` and `configSources.enrich`, because a
  switch you can only see when it is on is not provenance.
- **Nothing derived that the pin does not implement.** Interpreted text is
  the pinned client's own (`parseAllo`, `parseConditionalText`), served
  verbatim including its quirks, and always beside the raw facts it was
  derived from — type, index, value — grouped per raw allocation, because
  the interpreter fans out and a flat list of parsed lines would not
  correspond to what the world stores. Where the pin interprets nothing,
  the raw facts stand alone. This is the pools rule (§3.11) applied to
  text: serve the facts, do not invent the formula. It is also why a quest
  objective's index resolves for target types `ROOM` and `ITEM` and no
  others — the pinned client resolves exactly those two against a registry,
  the item and room index spaces overlap at low indices, and a plausible
  wrong name is worse than a bare index.
- **The classification artifact is not optional.** Every string the flag
  adds is `registry` game content, entered in
  `docs/string-classification.json` with the mandated hand review. This is
  load-bearing, not bookkeeping: the fail-safe resolves an unlisted string
  to `authored-prose`, and the envelope then DELETES it from every default
  answer — silently, and invisibly to a gate that only compares derived
  path lists against present ones. G3.f therefore asserts each enriched
  field is present with the flag on and absent with it off.

**Enrichment is payload, not reads.** Every fact above is already computed
on the path that serves the answer today and thrown away at the projection —
`Inventory.item` is a full item shape, `Listing.item` and `Listing.payItem`
are too, `getQuest` computes rewards for every registry row. Measured on the
0.4.0 fixture: the whole-registry parse costs 2.9 ms against a 6.8 ms
answer, a per-item parse 0.001 ms. What it does cost is bytes, so the
population map is deliberate: decision surfaces are enriched (what you
hold, what you can buy, what a quest pays, where you are), history rows are
not (`feed`, `battles`, `portal`, `transfers` — the same 70 rooms and 177
items recur page after page, and the description is one read away).

### 3.13 Payload economy and the leveling loop (0.5)

Settled with the 0.5.0 surface. **A reader that cannot afford to read an
answer has not been served it, and a truth that is only reachable through an
answer nobody can afford is not on the surface at all.**

§3.11 fixed the floor of what must be *readable*; §3.12 moved the tooltip
facts to where they are *read*. Neither asked what an answer COSTS. Measured
over four agent arms of one run, against a 65,536-byte reader: the
account-form `quests` answer ran to 195–221 KB and was cut off every single
call — 9.1 MB over 143 calls, 41 % of every tool-output byte in the run — so
quests past roughly the fiftieth were invisible for the whole run, to an
agent that was surveying them deliberately. `room` answers reached 360 KB in
a crowded room, `node` 266 KB, `leaderboard` 175 KB, `trades` 111 KB, `party`
281 KB. The cause is not one bug. It is a surface built one query at a time
where every listing answered with everything it had.

Three consequences, and the third is the one that is easy to get backwards:

- **Compact is the DEFAULT, not a flag.** A listing serves one row per
  entity — the identity and the few scalars a decision turns on — and never
  prose. Registry description text is the largest single cost measured
  (85 KB of a 141 KB quest answer is dialogue, byte for byte the same on
  every call) and is also the part a consumer is most likely to already
  have. Where the old shape is genuinely wanted, `--full` serves it. Making
  compaction opt-in instead would have left the default answer broken for
  every reader that never learned the flag existed, which is the population
  the change exists for.
- **A cap is honest or it is a lie.** Some lists cannot be compacted below
  the cap at any field selection: one room holds 1,561 accounts, and even a
  row of `{index, name, kamiCount}` each still runs past 64 KB. Those lists
  are capped — and every capped answer carries the true total beside the
  served count, because "nobody else is here" and "the rest did not fit" are
  different facts and a reader that cannot tell them apart will act on the
  wrong one. Row order is deterministic and unconditional for the same
  reason: a cap over an incidental iteration order is a lottery, and a
  `--full` answer ordered differently from the capped one cannot be
  reconciled with it.
- **Dropping a field is a version advance, not a flag.** This is where
  §3.12's contract has to be restated rather than extended. The `enrich`
  flag's promise was byte-identity *to 0.3.0*, and 0.5.0 changes default
  answers deliberately, so that promise cannot be carried forward by
  renumbering it. What the flag still guarantees, and what G3.g still
  proves, is that it adds fields and removes none against **this release's
  own defaults** — a frozen baseline for what comes after, not a
  cross-version identity claim. Saying otherwise would be claiming a
  property the release does not have.

**The leveling loop, and why a half-served loop is worse than an unserved
one.** The same release serves experience, the next-level requirement, a
readiness flag, the blocker when it is not ready, and unspent skill points,
on the base surface. Until 0.5.0 this surface served `level` and no `xp`
field anywhere — and an agent in the last run held the belief "check
lens_kami xp field" to the end of its run while sitting on 6,584 banked
experience at level 1, roughly seventeen levels' worth. Every input was
already computed on the path that answered it and discarded at the
projection; the only new work is the requirement curve, a ported upstream
function this port had never called.

Readiness is where a pane and the state disagree, and §3.11 already says
which wins. The reference client renders the level-up affordance two
contradictory ways — its party card checks experience alone, its kami bar
checks experience AND resting — and the chain's own `KamiLevelSystem`
requires both. The served flag is the strict one, with `levelUpBlockedBy`
naming which condition fails in the client tooltip's own precedence, and
the raw `xp` and `xpRequired` beside it so a reader can reconstruct either
pane. Copying the looser arrow would be mirroring a pane.

**Where a signal goes is part of what it costs.** The compact `roster` is
the one answer whose compactness is contract (G7.a, a frozen marginal-bytes
ratio), and the cheap leveling signals ride on it as SETS on the account
block — `levelUpReady: [indices]`, `skillPoints: [[index, points]]` —
rather than as fields on the kami rows. Measured on the largest roster in
the world (1,050 kamis): per-row fields cost 62.75 B/kami, a ratio of 0.234
against the frozen 0.25 and 0.310 in the worst case, so that placement
would have passed the gate on the luck of one roster's composition. The set
form measures 46.86 B/kami — unchanged from 0.4.0, and unchanged BY
CONSTRUCTION, because the gate's marginal is computed over `kamis[]` and
anything outside it cancels. A guarantee that holds by construction is worth
more than one that holds by measurement.

**Amendment (0.5.1): `--stats` sits OUTSIDE this contract, deliberately.**
The kami-sheet block (§3.16) adds an identical ~293 bytes to a compact
roster row and to a fat party row, so it is a rounding error on one and
roughly a tripling of the other: the frozen ratio goes to ~0.6 by
arithmetic, not by drift. Raising the threshold to accommodate it would
destroy the thing the threshold is for — it exists to catch the DEFAULT
answer getting fatter, and the default answer has not moved a byte. So
the compaction contract is defined over the flag-off roster, G7.a asserts
only that, and the flag-on marginal is recorded beside it as a report
line so the cost is on the record rather than invisible. What the flag
does inherit is the other half of §3.13: **it brings the standard row cap
with it**, with the true total beside the served count, because the
uncapped `--stats` roster projects past 300 KB on the largest rosters in
the world and an answer nobody can read has not been served.

**Refusals name their cause.** `requirementsMet: false` was a bare boolean
on 97 of 187 quest rows, and the layer computed the per-requirement status
for every one of them and threw it away — so a reader could learn *that* it
was blocked and never *by what*, which §3.11 exists to refuse. The failing
requirements are now named, with the pin's own words for each ("Complete
Quest [Ringing Any Bells III]"). The same principle adds a `reason` to an
ineligible liquidation preview and an `exits` list to a room: three
surfaces where the answer reported a verdict and withheld the fact behind
it.

**A silent argument is worse than a rejected one.** Found while
investigating this change and fixed with it: the CLI carried a hand-written
allowlist of three query-argument spellings and routed every other
`--`-prefixed token into a client-flag set that dropped what it did not
recognise. `--full` would have been swallowed, and so would a typo of it —
returning a *different answer*, silently. Queries now declare their own
argument vocabulary and an undeclared option is a usage error. Fail loudly,
never lie (§3.1) applies to the arguments as much as to the answers.

**And the fix only reached one of the two entry points (0.5.2).** 0.5.0
fixed the CLI and left the SOCKET exactly as it was — which is the path the
harness and the agents actually use. Found the day 0.5.2's own flags were
first exercised: `account 3379 --slim` over the socket returned the whole
roster with `ok: true`, and `node … --eligible-only` returned an unfiltered
answer with `ok: true`, while the same daemon refused the identical tokens
on the CLI with `unknown option '--slim' for 'account'`. Not a missing
feature — a **wrong-but-plausible answer to a question the caller did not
ask**, from a caller that had no way to tell. Worse than the 0.5.0 defect it
descends from, because the flags now exist: a consumer built against 0.5.2
and pointed at a 0.5.1 daemon gets the roster it explicitly asked not to
get, silently. (That is also why a mixed-version window is unsafe and why
the redeploy order is the lens first.)

The routing rule now lives in **one module** — `src/queries/registry.ts`,
beside the vocabulary it enforces — and both the CLI and the socket call it.
Written down twice is how the two came to disagree; the test asserts the
refusal for **every** registry entry on **both** paths, so a query added
later cannot reintroduce the gap on one side only. The one respect in which
the vocabularies legitimately differ is that the CLI's client flags
(`--prose`, `--no-authored`, `--stateless`) are request FIELDS on the
socket, not argument tokens — so the socket refuses them in `args` too,
which is the same defect running the other way.

**Two more flags, from measured reader cost (0.5.2).** Both come from the
same place the compaction did — a caller paying for an answer it did not
want — and both are opt-in, so every flag-off answer is unchanged.

- **`node --eligible-only`.** A liquidation sweep read 12.2 MB and 21,315
  harvest rows to find 1,737 eligible pairs worth about 250 KB. The daemon
  already computes the liquidation preview per row; the caller was filtering
  client-side and paying for the transport. Measured live 2026-08-27 with a
  real attacker: node 86 went 1,300,288 B → 15,900 B (28 eligible of 2,165),
  node 9 500,709 B → 3,489 B (6 of 835), node 10 46,696 B → 1,731 B (3 of
  77). The filter runs on rows this query already built, after the
  deterministic sort and **before** the row cap, so `--eligible-only --full`
  caps a filtered list rather than filtering a capped one. `harvestsTotal`
  keeps reporting the whole node and `harvestsEligible` says how many
  passed — an empty `harvests` list must read as "none in reach", never as
  "nothing here". It requires `--with-vitals` and an attacker argument and
  refuses without them: eligibility is a *pairing*, not a property, and
  silently serving an unfiltered answer to a caller who asked for a filtered
  one is the silent-argument defect above.

  **The filter is TARGET-SIDE, and the attacker's own gate is reported once
  (0.5.3).** 0.5.2 filtered on `liquidation.eligible` = `canLiquidate`,
  which folds `isStarving(attacker)` and `onCooldown(attacker)` into a
  question about the targets. In a zero-cooldown kill loop the attacker sits
  at HP 0 for 4–6 s after every kill, so a read inside that window answered
  `harvestsEligible: 0` on a node holding 20+ targets under the threshold —
  a payload **indistinguishable from an emptied node** (observed node 35,
  block 32677631, 2026-08-28). The list was being used to report a fact
  about the caller, and emptiness is the one payload that cannot carry a
  reason. The served rows are now the rows whose preview is target-side
  eligible — `threshold > 0 && margin > 0`, the occupant's projected HP
  below the attacker's threshold — and the attacker's own gate is a single
  field, `attacker.blocked` (§3.8), present whenever an attacker argument is
  given, filter or no filter. Two questions, two answers: "is anything in
  reach?" and "can I act?".

  Three consequences worth stating rather than discovering. The per-row
  `eligible` and `reason` keep their **full-pairing** meaning unchanged, so
  a served row may read `eligible: false, reason: ATTACKER_STARVING` — the
  alternative, narrowing `eligible` to match the filter, would have made the
  flag cheap and the field a lie. The predicate reads the numbers the answer
  **serves** (`threshold`, `margin`) rather than re-evaluating `canMog`,
  which re-enters `calcHealth` and therefore the clock: two evaluations a
  microsecond apart can straddle a `Math.floor` boundary, and a filter that
  disagrees with the `hp` printed beside it is a defect waiting to be
  reported. And with a **healthy** attacker the two predicates coincide
  exactly, so every 0.5.2 answer is unchanged — asserted, not assumed
  (G7.c).
- **`account --slim`.** The account read returns the whole kami roster,
  which is right for a detail surface and wrong for the thing callers kept
  needing: an index → name lookup. A 164-kami account measured 22,969 B
  (about 46 KB pretty-printed, which tripped a consumer's tool-result cap
  outright) and a 77-account world scan paid that per account; the caller
  worked around it by bypassing the harness and shelling out to the daemon
  CLI. Slim serves identity — id, index, name, both addresses, room,
  stamina — with `kamisTotal` / `kamisServed: 0` so a roster-less answer is
  never mistakable for an account with no kamis, and **nothing else**: no
  roster, no musu, no reputation, no bio, and no `gas`, which means slim
  makes **no chain read at all**. Measured hermetically: a 251-kami account
  34,050 B → 312 B.

The gate for both is equality, not size (G7.c). A filter that dropped the
wrong rows would look like a *better* saving, so the filtered rows are
asserted byte-equal to a client-side filter of the unfiltered answer at the
same block, and every slim field byte-equal to the full answer's same field —
absences included, since a slim answer that quietly kept the roster would
pass a field check trivially. The bytes are recorded; the equality is
asserted.

0.5.3 adds a case to that gate on the same principle. A **starving** attacker
must still be served the targets in reach, with each row keeping its
full-pairing verdict and `attacker.blocked` naming the gate once; and the
number of rows the 0.5.2 predicate *would* have served — 0, on a node with
targets — is recorded beside them, which is how the size of the defect stays
on the record. The healthy-attacker case keeps its 0.5.2 byte-equality and
gains the coincidence assertion — the two predicates select the same rows
there — which is what makes "0.5.2 answers are unchanged" a checked claim
rather than a promise.

**The cooling half of that enum is a recorded coverage gap, not a covered
case.** Cooldown is a clock fact, so the case needs a pinned clock, and the
pin does find cooling attackers with targets in reach (kami 83 on node 62, 28
targets, at G3.g's pin). It does not survive being pinned *inside* G7.c:
pinning after that gate's earlier queries have run leaves every occupant
projecting to full health, so the same pin on the same fixture reads 0 targets
where a pin-first process reads 28 — and clearing the kami, harvest, rate and
timestamp caches after the pin does not restore it. Something in the
projection path is stateful across a process beyond those caches. A case built
that way would have asserted `0 == 0` and called it a pass, so it was dropped
rather than shipped, with the measurement recorded in the gate and the
mechanism named here. Doing it properly means a pin-first script of its own,
as G3.g is. Note what is and is not uncovered: starving and cooling reach
`attacker.blocked` through the same function and the same precedence, so the
gap is one enum value, not a code path. **That process-history sensitivity is
itself a finding** — a "hermetic" gate is only hermetic if it pins before its
first read — and it belongs to the projection layer, not to this release.

### 3.14 An answer must not be able to lie (0.5)

Settled with the 0.5.0 correctness pass. **Where a surface cannot tell the
truth it must refuse, not substitute something that looks like an answer.**

§3.11 fixed what must be readable; §3.12 moved facts to where they are read;
§3.13 made answers affordable. This one is about the answers that were
*already wrong* and did not look it. Four of them shipped for months, and
each cost a reader real time, because each was indistinguishable from a
legitimate reading:

- **`null` that means "the computation broke".** A config read that landed
  before its component hydrated structured to NaN, JSON rendered NaN as
  `null`, and every harvesting kami's HP came back `null` — for one arm, for
  six days, 856 rows to 2. The poison was permanent because the cache stored
  the sentinel and never re-fetched it, and the guard meant to force a
  re-read compared against zero, which NaN is not. The shape that self-healed
  was the harmless one; the shape that mattered sailed through.
- **`NOT_FOUND` that means "the daemon has not started yet" (0.5.2).** A
  daemon wedged before LIVE has a mirror that is empty, not a world that
  lacks the thing you asked for — and it answered `NOT_FOUND: node 9 not in
  mirror` to every read, for nodes 9, 10 and 86 in one observed session. A
  caller cannot tell that from "no such node", and the two call for opposite
  responses: wait, versus stop asking. Any world read while the daemon is
  not LIVE now answers **`NOT_READY`**, with the state and percentage in the
  message; `NOT_FOUND` means "LIVE, and the world does not hold this" from
  here on. `status` and `health` keep answering, because a health surface
  that goes dark when things are unhealthy is not one. This cannot fire on a
  post-LIVE stream outage — nothing moves the sync state away from LIVE once
  reached — so degraded-state honesty is untouched: last-synced state keeps
  being served, stamped `stale`.
- **`NOT_FOUND` that means "we looked you up wrongly".** Accounts that
  plainly existed answered "not in mirror" when addressed by name — because
  the name cache stored a match only when there was more than one, so the
  ordinary case of exactly one was never cached and the lookup returned its
  own miss. By owner address it failed twice over, matching a raw string
  against a value the mirror stores normalised.
- **`0` that means "no such thing".** `config <name>` read a name the world
  has never defined and answered zero. An agent invented a plausible
  configuration family, queried it, and had its invention confirmed; it
  carried the false model for about twenty sessions.
- **A number that is not the number.** A packed uint256 coerced through
  `Number()` served `1.35e+68`; an entity id in a condition value did the
  same. §1.2 already said values are verbatim or absent — this applies it
  where a lossy cast had quietly opted out.

The rule that covers all four, and the one worth carrying forward: **the
failure modes of a query are part of its contract.** A surface gets to answer,
or to name why it cannot. It does not get to answer something else. So a
non-finite value now refuses at the serialization boundary with a counted
tripwire rather than becoming `null`; vitals refuse while the config block is
unusable; a config name the world does not hold answers `NOT_FOUND`, which is
already this surface's word for "no such thing"; and a value that will not fit
a JSON number is absent from the field that would have lied about it, with the
verbatim form served beside it.

Refusing is a real cost and it is worth being honest about that too: a query
that used to return something now returns an error, and a consumer that
treated any 200 as success will see failures it did not see before. That is
the point. With the cache guards and the re-read fix in place the refusal
paths should be nearly unreachable — they exist to make the remaining
unreachable case loud rather than plausible.

**One thing this section deliberately does not do.** Three of these four were
defects in VENDORED files carrying `changes: none`. §4.1's doctrine is that
upstream defects are excused with proof and port defects are fatal — but a
faithful port of a defect that produces a *silently wrong answer* is not
fidelity, it is the defect with our name on it. Each fix lands as a documented
divergence in §4.2 naming the upstream path, on the precedent set at 0.3.0
when the refresh-window interaction was fixed rather than preserved. Parity is
with what the client *shows a player*, not with the way it happens to break.

### 3.15 What a block number promises

`meta.blockNumber` is a **lower bound**, and saying so is the whole of the
contract. It is the highest block whose updates the mirror had applied when
the answer began building, captured at dispatch — so a long answer can
include state from later blocks, never earlier ones. It does not mean the
mirror has seen every block up to that number, and it does not advance for a
block that produced no world events.

Two consequences a reader has to know:

- **A write is not visible until the mirror has ingested the block carrying
  it.** There is no read-your-writes guarantee here and no mechanism that
  waits for one; a consumer that has just submitted a transaction and wants
  to see its effect must compare `meta.blockNumber` against the block its
  receipt names.
- **A Kamiden-sourced answer's `blockNumber` describes the MIRROR, not the
  feed.** `market`, `trades` history, `battles`, `portal` and `transfers`
  carry rows from a service with its own independent lag, joined against
  mirror state. The stamp is honest about the join; it says nothing about how
  fresh the service's rows are.

**How far behind is it? (0.5.1).** Until now, nothing on any surface could
answer that. `status.blockLag` was declared in the schema at 0.5.0 and never
populated; `meta.blockNumber` is a lower bound that does not advance on an
event-less block; and the only other signal was the boolean `meta.stale` and
a `degraded: ["stream-stalled:Ns"]` string. After a laptop wake — the case
this exists for, now that a lens daemon runs as a launchd service on a Mac
that sleeps — a consumer could not tell a mirror three blocks behind from one
three hours behind. `status` now carries `blockLag`, `headBlockNumber` and
`headSampledAt`, from one `eth_blockNumber` taken at status time, and **all
three are absent together when that read fails** — never 0, never null
(§3.14). The head and the timestamp are served beside the lag because a
subtraction you cannot check is an assertion, and a head number of unknown
age is not evidence.

The read is **bounded at two seconds and never blocks the answer**. `status`
is the daemon's own health surface — the local watchdog polls it every 60 s
and the container healthcheck every 30 s, and both read a hang as
"unreachable" — so a stalled RPC has to cost three optional fields rather
than the answer. Same rule the gas block already follows (§3.13), applied to
the one query that must always respond.

**`meta.stale` is NOT derived from it, in this release.** `stale` keeps its
0.5.0 meaning exactly. A nonzero `blockLag` is the normal resting state of a
healthy mirror — that is what "does not advance on an event-less block"
means — so a threshold set before anyone has seen the distribution would
stamp healthy answers stale. The lag is information; the release that
measures a thing is not the release that acts on it.

**What a heal moves, and what it does not (0.6.0).** `liveBlockNumber` is the
block of the last event APPLIED, so it does not move across a block that
produced no world events — and a recovery range that turns out to be empty is
exactly such a case. Heal events carry the block stamp
`createFetchWorldEventsInBlockRange` already gives them, the END of their
chunk, so a heal that finds logs does advance `liveBlockNumber`; a heal over
an event-less range advances nothing, and that is honest rather than
convenient. What it can always advance is `status.sync.reconciledThrough`:
every block up to and including it has been covered by a COMPLETE chain
range read, whether or not those blocks carried logs. That is the lower bound
`liveBlockNumber` has never been, and it is why the reconcile reports it
separately instead of forging a block number into the event path. The
distinction matters at exactly one moment — after a quiet period, where a
mirror that has read everything and a mirror that has read nothing look
identical in `liveBlockNumber` and differ in `reconciledThrough`.

**The verified lower bound rides on every answer (0.6.1).** `meta.blockNumber`
is the lower bound of APPLIED state: the highest block whose updates the
mirror had applied when the answer began building, advanced by whatever the
stream happened to deliver. `meta.reconciledThrough` is the lower bound of
**chain-verified** applied state: every block up to and including it has been
re-read from the chain and applied (§3.17). The second is the stronger claim,
and it is the one a reader wants when it is about to act.

It was reachable only through `status` until now, which is the wrong surface
for it. A caller that has just sent a transaction and wants to know whether
this mirror can yet see it must compare the receipt's block against something,
and the honest something is the verified bound — but `status` is a *different
answer*, taken at a *different instant*, so pairing it with a world read is
the same lie of convenience §3.8 refuses for the clock. **A reader comparing a
receipt block should use `meta.reconciledThrough` when it is present, and
`meta.blockNumber` only as the weaker fallback.**

It is `number | null`, never optional and never `0`. `null` means this process
has verified nothing — before the bootstrap seeds the baseline, and on any
path with no sync worker behind it, such as the stateless CLI. A `0` would
read as "verified through block 0", which is §3.14's whole objection.

### 3.16 The kami sheet, and a flag that pays for itself (0.5.1)

Settled with the 0.5.1 surface. **A fact the projection already computed
and threw away is not an absence, it is a discard — and the reader pays
for it either way.**

`docs/coverage.md` carried the row "kami sheet: stats / traits /
equipment" as **not served** through five releases, while
`shapes/Kami/stats` and `shapes/Kami/traits` sat in the mirror, parity-gated
by G2.a/G2.b, refreshed unconditionally on every single kami read
(`KAMI_REFRESH` sets `stats: -1, traits: -1`, and `app/cache/kami/base.ts`
calls `getKamiStats(..., true)` — bonus folded in) and then dropped at the
projection. Four queries — `kami`, `roster`, `party`, `node --with-vitals`
— all walked that path. The cost of serving it is zero additional mirror
reads. This is the same shape of finding as the 0.5.0 leveling loop, and
it surfaced the same way: a play session could not answer "how strong is
this kami" from a lens that had the answer in memory.

Four decisions, and three of them are about not lying:

- **Opt-in, and byte-identical without the flag.** `--stats` on the four
  reads that already project a kami; every addition is a trailing
  conditional spread, so a flag-off answer keeps its exact 0.5.0 key set
  AND key order. G3.g proves it against the frozen 0.5.0 baselines with no
  re-capture. A new query would have been the wrong shape: the reader
  wanting stats is the reader already asking for the kami.
- **`total`, not `current`.** The effective value after skills and
  equipment is `(1 + boost/1e3) × (base + shift)` — the ported
  `Stat.total`. Calling it `current` would have put two different numbers
  under one word in one answer, because `hp.current` (drained/regenerated
  live health) is already served beside `hp.total`.
- **No `rate`, and only four stats.** `Stat.rate` is written by
  `updateHealthRate` and nothing else, so it is a structural zero on
  power, harmony and violence — a lie-shaped zero (§3.14); health's rate
  is already served as `hpRatePerHr`. And the four stats are exactly the
  four in the chain's `GetterSystem.getKamiByIndex` tuple: `slots` and
  `stamina` exist in the mirror but not in that tuple, so serving them
  would put numbers on the surface that no gate could hold to chain.
- **Traits deferred, and said so.** The chain-checkable form is trait
  INDICES, +66 B/kami, which pushes a 150-kami `roster --stats` to 94 % of
  the reader budget for identifiers nothing on the surface can resolve
  yet. The coverage row now reads served for stats and affinities and
  **not served** for traits and equipment, rather than one status for
  three different things.

**What the gate found, including that its own first claim was wrong.**
`GetterSystem.getKamiByIndex` reverts for some kamis the mirror serves
perfectly well. The investigation saw 19999 answer, 20000/20001/20010/20100
revert and 20002 answer, and generalised to "it reverts for every kami with
no owning account". **That was wrong, and the gate is what caught it**: the
probe reached kamis 1, 6 and 71 — equally account-less, all answered. The
real correlate is the STATE, and once the probe was spread across the whole
index range instead of taking the first few in mirror-iteration order, it
separated cleanly on twelve samples: `721_EXTERNAL` — bridged out of the
world — 5 answered / 0 reverted; account-less and still in-world (`RESTING`,
`DEAD`) 0 answered / 7 reverted. 4,886 of the mirror's kamis are
account-less.

Two things follow, and the second is the general one. The vector samples
OWNED kamis only, because those are the ones the chain answers for
reliably — a gate that sampled blindly would report a chain-side refusal as
a parity break. And a finding gets recorded as its own evidence: G2.d writes
the per-index results and a state grouping it derives from them, not a
sentence composed in advance, because the sentence composed in advance is
the thing that was wrong. G2.d samples owned kamis only, probes unowned ones deliberately,
and records the result. Two traps sit beside it: `stat.shift` on an ethers
`Result` resolves to `Array.prototype.shift` — the function — and
`Number(fn)` is `NaN`, which JSON serializes as `null`, so a first pass of
the vector produced `"shift": null` for every kami and looked like data
(§3.14, exactly); and the mirror's `shift` is bonus-inclusive while the
chain's stored value is not, so G2.d records both numbers and fails rather
than tolerating a divergence it cannot explain.

### 3.17 Recovery reads the chain (0.6.0)

Settled 2026-09-06 after the L-1 investigation. **The fast path may be
wrong; the authority may not.**

The occasion. On 2026-09-06 the lens served six kamis as HARVESTING for three
and a half hours after they had stopped harvesting on chain, and a seventh
for the same reason a minute later. Twelve more kamis lost the identical way
in the next two blocks and were invisible, because they restarted harvesting
later and the restart overwrote the loss. A restart of the daemon healed all
seven, which is the signature of a mirror that is wrong rather than a chain
that is: the checkpoint path refetches a now-complete range, and live events
are never folded into it (§3.5).

**What was measured** (against `api.prod.kamigotchi.io`, 04:10–04:30 UTC;
scripts and raw outputs in the L-1 evidence bundle):

1. `GetEventsSince(sinceBlock)` is INCLUSIVE of `sinceBlock`, has no upper
   bound, and answers a **deduplicated latest-value diff** — 43,529 events
   over 43,529 distinct `component|entity` keys — not an event log. Its store
   is filled log by log **in step with the stream**: a read ~1 s after a
   block's first log returned 49 of that block's 60 writes, and the count
   kept climbing for seconds afterwards. The `latestBlock` it reports names a
   block that may still be half-ingested.
2. The stream is ONE CHUNK PER LOG, and the server closes the subscription
   every ~30-40 s by design. The 2026-08-26 → 09-06 daemon log holds 17,369
   gap-fills. **Every one of them was a read of (1) at the worst possible
   moment** — the instant after a reconnect, when the diff's head is exactly
   the part still being ingested.
3. Three code facts made a loss permanent rather than transient. The 10.5 s
   no-data timeout sat DOWNSTREAM of the awaited gap-fill, so a slow fill
   tripped it, `retry` resubscribed, the old pipeline's events went to a dead
   subscriber, and its continuation still advanced the SHARED cursor. The
   inner teardown was `() => {}`, so the old gRPC call was never cancelled
   and two pipelines could run against one cursor. And
   `fetchEventsInBlockRangeChunked(from, to)` with `from === to` yielded zero
   steps, so the RPC fallback fetched nothing for a same-block gap — the
   common case, since one chunk per log means gaps open mid-block (136 of the
   17,369).

**The principle.** Kamigaze's stream and its diff are fast paths. The chain
is the only authority, and every recovery path reads it. The mirror is
"latest write per key across everything applied", so there is exactly one
ordering invariant: **never apply a log older than one already applied for
the same key.** With a serialized pipeline that holds whenever a recovery
range ENDS AT THE CURRENT CURSOR and the RPC node is at or past that block.
Both conditions are enforced rather than assumed.

**One primitive.** `healRange(from, to)` reads the range inclusive through
the existing 50-block chunks and returns every event in it or none. Its
precondition is `rpcHead >= to`: the free `blockNumber$` value is checked
first and trusted only when it already satisfies the target — a cached head
BELOW it is not a refusal, because an ethers v6 `WebSocketProvider` can go
permanently silent without erroring (§3.2, 0.5.2), and a stale head must
never turn every heal into a deferral — after which the HTTP provider is
asked once a second for at most fifteen. Note that upstream's own
wait-for-the-node ladder in `evm/blocks.ts` is unreachable here: it is gated
on `supportsBatchQueries` and the daemon sets `batch: false`. This guard is
the only one in the process.

**A deferred range is never partially applied.** If the node is behind, or
the subscription is torn down mid-heal, the range is recorded in
`status.sync.unhealedRanges`, the cursor stays where it is, and nothing is
applied. Partial application with an advancing cursor is precisely the 0.5.3
defect. The next gap heal covers the widened span, and the periodic reconcile
covers it regardless.

**A periodic reconcile, because a gap-triggered heal can only fix gaps the
stream noticed.** Every `reconcile_interval_ms` (120 s by default; 0 disables
it and `status.sync` says so) a tick is merged into the stream pipeline
AHEAD of its `concatMap`, so it is processed serialized with chunks and can
never race one. It heals `[reconciledThrough + 1, cursor]` and, on success,
moves `reconciledThrough` to the cursor. Its source and timer live in the
closure that survives `retry`, alongside the cursor itself: at one
subscription close per ~55 s, an interval owned by the raw subscription would
be reset before a 120 s tick ever fired. 120 s is chosen against that same
cadence — a tick lands every second or third connection, and its range stays
a handful of blocks wide.

**Kamigaze is not deleted, it is bounded.** A gap wider than
`GAP_RPC_MAX_BLOCKS` (2,000 — about 40 chunked `eth_getLogs`, long enough to
outlive the subscription) is served by the diff first and then topped up from
the chain over `[latestBlock - 2, cursor]`, for the head the diff may have
half-ingested. **Never the reverse order.** In practice this branch is
approximately dead: the measured gap distribution is modal at 4 blocks and
nothing observed came near 2,000, so the diff's remaining real job is the
bootstrap `fillGap`. That is the intended consequence, not an accident.

**Cost.** One `eth_getLogs` for a 2-block World range measured 616 ms and 18
logs (2026-09-05, public endpoint), against ~1,580 gap heals per day at the
observed cadence. The traffic moves off the rate-limited Kamigaze budget the
live daemon shares and onto the public RPC, where it is comfortably within
tolerance.

**Enforcement.** `test/stream-heal.test.ts` is hermetic and covers the range
arithmetic, the head guard, both deferral paths, the abort, the timeout
placement, the reconcile and the retry policy — none of which had any test at
all before this release. G8.b measures the live half: three severs on a real
daemon, then a chain cross-check of every ACTIVE harvest.

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

**The bridge from a CDN image to the live stream (0.6.2, delta-first —
divergence 12).** A CDN load lands at the exporter's block, which is up to
an export interval behind the stream's start, and that window has to be
closed before the daemon can go LIVE over it. **The snapshot delta runs
ALWAYS**, first — the same partial `fetchSnapshot` the ten-minute
checkpoint already trusts, on a cache whose cursors `fetchFromCdn` set,
removals included — and then the ORDINARY `fillGap` from the delta's head
**with the RPC fallback ON**. A delta that throws gap-fills the whole
window instead: ~144 `getLogs` calls at worst, slow and
chain-authoritative, which is the property that matters when the snapshot
service is what just failed. `skipRpcFallback` is never passed on this
path. The reconcile baseline (§3.17) seeds after the bridge exactly as it
does after `fillGap`: the bridge closes the same window, and a baseline
left unseeded would make every reconcile tick a counted no-op.

*This is a divergence, and the reason is what upstream cannot see.*
Upstream asks the STREAMER first over the whole window with the RPC
fallback OFF — reasonably, since the window can be two hours wide and a
log scan walks it fifty blocks at a time — and reads an EMPTY answer as
"the streamer's cache no longer reaches back that far", running the delta
only then. In kami-lens "empty" conflates four different facts: the
streamer refused below its eviction watermark; the gRPC call threw and was
swallowed because the fallback was off; the window was genuinely empty;
or — kami-lens only — the answer was SHORT, because the port skips an
undecodable row where upstream aborts the load (the hygiene divergence
below), so a window whose rows were undecodable answers short rather than
empty. Guessing wrong is not a retry but a permanent hole: the whole
bridge window lies BELOW the reconcile baseline seeded immediately after
it, where every tick is a counted no-op by design, so the daemon would
reach LIVE reporting `degraded: []` over blocks nothing ever re-reads —
the 2026-09-06 L-1 class, one layer up. So the guess is not made. The
cost is one small delta per cold boot (measured: a 1,330-block delta and a
4-block gap on the recorded G10.a boot), and the partial loads are still
served by the snapshot service either way.

Counted as `decodeFailures` when a row is skipped, on either path.

**The apply yields to the event loop (0.6.3, L-11).** The CDN loader's
values and entities applies, and the gRPC path's values apply, run in
~50 ms time-budgeted slices that park on `setImmediate` between them
(`workers/sync/state/apply.ts`). Upstream does not, and could not know it
mattered: `storeValues` loops `value = await decode(...)`, `decode` is an
`async function` that never awaits anything, and an await on an
already-resolved promise yields to MICROTASKS only — never to the
macrotask queue, which is where socket reads and timers are serviced. On
2 vCPUs a values chunk takes ~11 s to apply, so for 11 s at a time the
process reads no socket data and fires no timer on time. Two things
followed, both measured on kami-factory on 2026-09-18:

- the other in-flight chunks' body reads starved until their
  `AbortSignal.timeout(CHUNK_TIMEOUT_MS = 30 s)` — a WALL clock — expired:
  a self-inflicted `TimeoutError` and a full ~11 MB re-fetch, on a link
  that was never the problem (`fetchSecondsInflatedByBlocking` 165 s
  against 80 s of wall);
- the only progress the daemon's pre-LIVE stall watchdog could see was "a
  whole values chunk applied" — four steps for an entire load — so one
  chunk that needed a retry exceeded 90 s of fingerprint silence and the
  daemon **tore down a load that was working**: cold→LIVE 271 s instead
  of 118 s.

The budget is in MILLISECONDS rather than rows because the same row costs
14.7 µs there and 1.5 µs on the Mac: any fixed row count is free-and-
useless on one machine or a yield-per-row tax on the other. The slicing
happens at the CALL SITE, not inside `storeValues`, which keeps the shared
upstream row loop byte-identical and works the same way for the
synchronous `storeEntities`. Two consequences are handled rather than
hoped over: progress moves on ROWS (fractional per chunk, so upstream's
single monotonic-by-construction derivation survives a denominator that
does not change), and concurrent chunk fetches are capped by
`os.availableParallelism()` so a small box is not holding five bodies it
cannot read. `PRELIVE_STALL_MS` and `CHUNK_TIMEOUT_MS` are untouched: the
fix is to stop lying to the watchdog, not to loosen it.

*Interleaving is safe, and it is not new.* Parking between slices lets two
values chunks interleave their applies at slice granularity — but they
already interleave at ROW granularity, because of the same per-row await
described above, and the chunks are consumed in whatever order the network
serves them, so the apply order across chunks is already arbitrary. What
that arbitrary order is allowed to be is bounded by the image: a values
chunk set is a partition of ONE state image at ONE block, where a
(component, entity) key has exactly one current value, so the same key
never arrives from two chunks and last-write-per-key cannot arise. The
gRPC path says the same thing from the other side — its delta resume
rewinds one block precisely because re-serving a boundary block's rows is
idempotent. The two orderings that ARE load-bearing are preserved:
components land before any value, and entities stay strictly in index
order (one sequential awaited loop, and slicing an array in order
preserves order inside a chunk too, which is what the append-at-the-tail
check requires).

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
- **A chunked range fetch that fetches nothing** (0.6.0, L-1):
  `fetchEventsInBlockRangeChunked` derives its step count from the
  EXCLUSIVE delta, so `from === to` yields zero steps and it returns
  `[]` having read nothing — while its own doc comment and every
  caller treat `[from, to]` as inclusive. That is the same-block gap
  the stream opens most often; 136 of 17,369 gap-fills over eleven
  days had `from === to` and healed nothing. The port takes the count
  from the inclusive span. Its progress fraction divided by the same
  delta and so was `0/0` = `NaN` on a one-block range, which
  `Worker.ts` pipes straight into the LoadingState component (§3.14).
- **A teardown that does not tear anything down** (0.6.0, L-1): the
  inner stream Observable returns `() => {}`, so the gRPC call
  outlives its subscriber and two pipelines can run against one
  cursor. The port gives each subscription an `AbortController` passed
  to `subscribeToStream` and aborted in the teardown — the lifecycle
  `src/kamiden.ts` already uses.
- **A cursor written after the subscriber is gone** (0.6.0, L-1): the
  chunk handler advances the shared `trackingState` at the end of an
  `async` body that has already awaited a gap-fill, with no check that
  the subscription still exists. Unsubscribing does not cancel a
  promise, so on a timeout-driven retry the dying pipeline advanced the
  cursor over blocks whose events had gone nowhere. The port checks a
  `closed` flag after every await and returns without touching the
  cursor. This is the L-1 defect proper; the two above are what made it
  unrecoverable.
- **Undecodable state rows** (decision, 2026-07-20 implementation
  session): upstream aborts the whole sync attempt when any
  snapshot/stream/gap-fill row fails component-value decode — bounded
  retries, then a dead client. The port instead skips the row,
  increments the `decodeFailures` tripwire (§7), logs
  component/entity/bytes, and surfaces degraded status. (Errata, same
  day: the decode failures that motivated this were traced to a
  kami-lens checkpoint-indexing bug, fixed the same session — an
  aligned sweep of the full Kamigaze stream found zero undecodable
  rows. The divergence stands as approved forward-looking robustness
  against contract-side drift, the §7 tripwire scenario — not as a
  response to an observed upstream defect.) Unifying principle for this divergence and the gate G1.b
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
| `eth_getLogs` cost at recent density | ~23 s per 10 k-block range (a MEASUREMENT of the endpoint, not the chunk size the code uses — see below) |
| log retention | trailing ~1.02 M blocks ≈ 25 days |
| behavior beyond retention | empty result, HTTP 200 — not an error |
| `eth_call` historical state depth | ≈ 50–120 blocks (measured 2026-07-21: ok at head−50, reverted at head−120) |

Consequences, and **the chunk size here is 50 blocks, not 10 k**
(corrected 0.5.1). This text used to say gap-fill runs "in 10 k-block
chunks", which no code path has ever done: both RPC gap-fill call
sites — `fetchGapEvents`' fallback and `fillGap`'s catch path, in
`src/workers/sync/stream/gapfill.ts` — pass a literal `50` into
`fetchEventsInBlockRangeChunked` (`src/workers/sync/utils.ts`, whose
own default is also 50). The 10 k figure in the table above is a
measurement of what the ENDPOINT costs per 10 k-block range, and it
was read back as a configuration value it never was. So: RPC gap-fill
of a one-day outage (~41 k blocks) is ~820 SEQUENTIAL `eth_getLogs`
calls of 50 blocks each. At that size each call returns ~800 logs and
the cost is dominated by round-trips rather than by log density, which
puts a one-day heal in minutes-to-tens-of-minutes, not the two minutes
the old text implied. Gate G8 measures the calls and the observed
chunk size on a real gap, and its first record (2026-08-27) answers the
question this paragraph used to invite: **a 10-minute gap never reaches
the RPC path at all.** The daemon healed through ONE Kamigaze
`GetEventsSince` call — 2,638 events, `rpcRangesRequested: 0` — so the
50-block chunk size never came into play and there is nothing here to
propose changing. (Reproduced across three runs of the gate: the
Kamigaze path every time, the RPC fallback never.) The chunk size binds only
where Kamigaze declines or is unreachable, which is what the deferred
2-hour leg exists to reach.

(Recorded because the gate's first attempt could not see this: both
gap-fill call sites log at DEBUG, the container ran at INFO, and the run
produced `gapFillPath: "neither-observed"` — a daemon healing a gap in
11.8 s with no evidence of how. The gate now sets
`KAMI_LENS_LOG_LEVEL=DEBUG` on its subject. A gate that cannot observe
its own subject is not measuring.) An outage
beyond the retention window cannot be healed from RPC at all — it
takes Kamigaze `GetEventsSince` (its own retention: unverified) or a
full re-snapshot. Because pruned ranges return empty success, the sync
layer treats "empty result from an old range" as suspect, never as
proof of no events. The retention window is remeasured as a
PORT_PLAN gate.

The state-depth limit is a separate constraint from log retention and
binds the *gates*, not the sync layer: chain cross-checks must pin
their `eth_call` reads close to head, because a read much deeper than
~50 blocks back reverts on the archive-less public endpoint. Every
chain-verifying gate therefore verifies against a freshly pinned
recent block — healing the mirror to it in two stages and batching the
verification reads through a pool — rather than against the block a
fixture was captured at. The depth is recorded per gate run (`g3b-*`,
`g6b-*` measurements) and consumed as a constraint; it is never
asserted, since it is the endpoint operator's pruning policy, not our
contract.

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
  initial block `44577`, the public Initia RPC/WSS endpoints,
  `https://api.prod.kamigotchi.io`, and — from 0.6.2 —
  `https://state.prod.kamigotchi.io` as `stateCdnUrl`, the production
  value the deployed web client's own bundle ships (§3.1).
  `kami-lens daemon` works with no config file.
- **`stateCdnUrl` is the one optional URL whose default is ON, and it is
  switched off by value rather than by omission.** Upstream's flag is
  inert until set; here the default is set, because zero-config means a
  fresh machine takes the FAST cold start without being told to, and the
  slow one is what every failure mode already falls back to. Off is the
  empty string, `false`, or `none` (and the TOML boolean `false`), at any
  precedence level, and off means today's gRPC cold start byte for byte.
  ONE CAVEAT, and it is stated because it cannot be fixed without
  changing every key: an EMPTY environment variable does not disable it.
  The env layer maps an empty variable to "not set" for every key, so
  `KAMI_LENS_STATE_CDN_URL=` falls through to the default;
  `KAMI_LENS_STATE_CDN_URL=none` is the spelling that works. The flag and
  the config file accept the empty string.
- **Config precedence**: CLI flags > env vars (`KAMI_LENS_*`) > TOML
  file (`~/.config/kami-lens/config.toml` or platform equivalent) >
  baked defaults. Keys: chain id, world address, RPC/WSS URLs,
  Kamigaze URL, state CDN URL, data dir, checkpoint interval,
  reconcile interval, optional default
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
- **Item-pool swap quoting.** Pool FACTS are served at 0.3 (reserves,
  fee, share supply, creation time, and a fee-exclusive reserve-ratio
  valuation). The swap-output formula is not: the pinned client carries no
  pool module, so porting it would mean transcribing contract math with no
  upstream implementation to be faithful to and no differential gate able
  to catch a transcription error — the two properties §3.3 and the G2.a
  gate exist to guarantee. Quoting arrives with a pin whose client ships
  the pool module, at which point the differential gate covers it for
  free. A reader holding both reserves and the fee has everything the
  formula consumes in the meantime.
- **Single-binary packaging.**
- **`replayOnto` loud refusal** (0.2.0 audit residual). The gates
  library replay primitive (`gates/g1/lib.mts`) silently no-ops when
  the base block already postdates the target; both current consumers
  (G2.b, G3.c) carry refuse-and-report guards, but the primitive
  itself should refuse loudly so a future consumer cannot re-create
  the silent wrong-state comparison the 0.2.0 audit caught in G3.c.
- **Fixture-set replay-base pinning at capture time** (0.2.0 audit
  residual). On the next natural G2.b capture event, the new fixture
  set gets a fresh pinned `replayBase` manifest entry from day one —
  the recovery rule in the current manifest's `replayBase.note`
  (gates/fixtures/g2b-observations.json) is the template. A base is
  pinned when the fixtures are born, never reconstructed after.

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
