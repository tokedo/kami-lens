# kami-lens

A headless [Kamigotchi](https://github.com/Asphodel-OS/kamigotchi)
client: it keeps a live local mirror of the game's on-chain world state
and projects it — through the game's own rules — into what a player
actually sees. Any agent, bot, or terminal user gets the same view of
the world the official web client renders, without a browser.

## Why

Kamigotchi state is lazy-synced on-chain: a kami's HP, harvest balance,
and cooldowns are only written when it acts. The web client does the
heavy lifting — it syncs ECS state and then computes live values
(current HP under harvest drain or rest recovery, musu accrued,
cooldown seconds remaining, time to full recovery, who else is on the
node) from last synced state + on-chain config + the clock. Anything
that plays without a browser is blind unless it replicates that
machinery. kami-lens is that machinery, headless.

## Principles

1. **Perception parity.** The coverage target is 100% of what the
   official web client shows a player, defined against a pinned
   upstream commit. Any gap in a release is documented explicitly,
   never silently.
2. **Locally installed, never hosted.** You run kami-lens on your own
   machine. Its only remote dependencies are the public Yominet
   RPC/WSS endpoints and the official Kamigotchi services (Kamigaze
   snapshot/stream, Kamiden feeds) — exactly the web client's
   dependency set. There is no hosted kami-lens service, and there
   never will be.
3. **On-demand JSON.** Perception is pulled, not pushed: query tools
   return world state (on-chain + projected) as JSON. Tools are
   general — a kami status report takes *any* operator as an argument,
   not just your own.
4. **Current state, web-client boundary.** kami-lens surfaces what the
   web client surfaces in-session — including its feeds (chat, kill
   feed, recent trades). Longitudinal history and analytics are out of
   scope.
5. **Formulas from the source.** Projection code is ported from the
   game's own open-source client and reads its constants from on-chain
   config entities, so game balance patches don't silently break it.
   Where the client ships data in code rather than on-chain, kami-lens
   ports it with the pinned commit and documents it in the coverage
   checklist.
6. **AGPL-3.0**, as a derivative of the AGPL-3.0 upstream client.

## Architecture

Three layers:

1. **Sync** — state mirror: Kamigaze snapshot + stream for bootstrap
   and push updates (the snapshot is a hard dependency for cold
   start), with pure-RPC event replay (`ComponentValueSet` /
   `ComponentValueRemoved` World events) for gap-fill within the
   public RPC's log-retention window; persistent local state cache,
   periodically checkpointed across restarts.
2. **Projection** — the game-logic layer: live HP, harvest output,
   cooldown/recovery timers, liquidation thresholds, computed exactly
   as the web client computes them.
3. **Interface** — a long-running daemon plus a CLI (and a library
   API); JSON out.

See [DESIGN.md](DESIGN.md) for the full design and
[docs/upstream-client-architecture.md](docs/upstream-client-architecture.md)
for the study of the official client this is built from.

## Configuration

Every setting resolves through one precedence chain — CLI flag > `KAMI_LENS_*`
env var > TOML config file > baked Yominet default — and the daemon's `status`
answer reports each effective value *and which level decided it*. See
DESIGN §5 for the full list; the one setting that changes what queries
return:

| Setting | Flag / env / TOML | Default | What it does |
|---|---|---|---|
| Payload enrichment | `--enrich true` · `KAMI_LENS_ENRICH=true` · `enrich = true` | `false` | Serves the client-tooltip facts inline where a result names an item or a room: item description, chain-derived use/equip effects, interpreted use requirements, quest rewards, and resolved room refs (DESIGN §3.12). Results only — no query, request field, or schema field changes with it, and with the flag off every answer is byte-identical to 0.3.0. |

```
kami-lens daemon --enrich true      # the daemon decides the surface
kami-lens inventory 2160            # every client of that daemon sees it
```

Enrichment is a **daemon** setting: one daemon serves one surface, and no
request field can ask for a different one. Booleans are strict — `true` or
`false`; anything else (including `1`) fails loudly at startup rather than
being guessed at.

**Keep the data directory's path short.** The query socket lives at
`<data-dir>/kami-lens.sock`, and operating systems cap a socket path at about
100 bytes (103 on macOS, 107 on Linux). If yours would be longer, the daemon —
and the CLI — refuse to start with a message naming the path, its length and
the limit, rather than bind a shortened path no client could find; pass a
shorter `--data-dir`.

### Memory

A first start loads the whole world into memory — about 4.5 GB at its peak.
Node does not give itself that much by default, so **the daemon raises its
own limit at startup and tells you it did.** You do not have to configure
anything, on a machine with roughly 8 GB or more.

Three things worth knowing:

- **If you set the limit yourself, that is what it uses.** `NODE_OPTIONS=--max-old-space-size=…`
  is always respected, even when it is too small — you get a warning saying
  a first start will probably run out, and nothing is overridden.
- **On a machine too small to finish the load, it refuses to start** rather
  than dying a few minutes in, and says what it needs. Roughly: under 7 GB
  available to the process and it will not start a first load unaided.
- **Raising its own limit needs Node 22.15 or newer.** On older Node it
  refuses with the one line that fixes it:
  `NODE_OPTIONS=--max-old-space-size=6144 kami-lens daemon`. A restart that
  resumes from a saved copy of the world needs far less and is unaffected.

`status` reports the limit it ended up with and who chose it — you, Node, or
the daemon itself.

### Minimum machine

Measured, not estimated (1.0.0, October 2026):

| | Needs | Measured |
|---|---|---|
| **Memory** | **8 GB of RAM** for a first start with no saved state, unaided. Below about 7 GB available to the process the daemon will not start a first load on its own (it refuses, with the remedy); below 5.5 GB it refuses outright. | Peak while loading the world: **4.1–4.6 GB** resident on a Mac (4.09 GB on a 2-hour run, 4.63 GB on the release's cold-boot gate), 3.3 GB in a one-processor 6 GB container, 3.6 GB on a 2-processor VM — the daemon's heap grows into what it is allowed. Steady once running: **2.17–2.25 GB**. Every ten minutes a separate process rewrites the saved world for about ten seconds and needs about 1.5–1.6 GB more while it does. |
| **Processors** | **1** is enough; **2** is comfortable. | One processor: running and answering 43 s after a first start from the state CDN, on the first attempt, with `status` answering throughout the ten-minute rewrite (longest wait 3 ms). |
| **Node** | **22.15 or newer** for a start with no configuration — that is the version that lets the daemon raise its own memory limit. On Node 20 set `NODE_OPTIONS=--max-old-space-size=6144` yourself. | |
| **Disk** | About **0.5 GB**: the saved world (~235 MB) and its previous copy. | |

A restart from saved state needs much less than a first start (about 2.3 GB),
so a machine that can do the first start can always restart.

## Status

**1.0.2.** Daemon, CLI, and library are implemented and
gate-verified against the pinned upstream commit and the live game,
with dated per-run evidence in `docs/measurements/`. The verification
suite is G0–G10 (G8, G9 and G10 are manual and live); every run writes
its own dated record, and the record — not this paragraph — is what a
given release rests on. The contract registry is [SPEC.md](SPEC.md);
per-surface coverage — what is served, what is deferred, what is out
of scope — is [docs/coverage.md](docs/coverage.md).

### What changed in 1.0.2, for the things that read this daemon

Every five minutes the daemon checks its clock against the chain, and until
1.0.2 it did so on the newest block it already had, which in a quiet moment
could be 20 seconds old — so for the next five minutes cooldowns read up to
that much too long and health, stamina and harvest totals a point low. It now
waits until the stream delivers a block newer than any it has seen and checks
against the newest block of that delivery, so the clock no longer falls behind
by however long the quiet moment lasted, and it still never runs ahead of the
chain. Nothing to do but upgrade: no field is added, renamed or removed,
`version` reads `1.0.2`, and `meta.asOf.clockSampleAgoMs` may now go past
300,000 on a healthy daemon while no new block arrives.

### What changed in 1.0.1, for the things that read this daemon

1.0.1 fixes a correctness defect in 1.0.0 and adds two fields to `status`.
Nothing else in any answer changes; `version` reads `1.0.1`, `upstreamPin`
is unchanged.

**What was wrong.** When two or more transactions in the same block wrote
the same value — a kami's health, a timestamp, a harvest's state — 1.0.0
could keep an EARLIER transaction's write instead of the last one, and its
periodic re-read of the chain could not correct it. The daemon then served
the stale value, with `degraded` empty, until that value was written again
in a later block. In a real five-transaction block, every one of the 7 values
written by more than one transaction was left on an earlier write; over one
hour of chain, 479 values ended up different from the chain. Every 1.0.0 daemon is affected; 0.6.x is not. The
cause: on this chain a log's position number restarts in every transaction,
and 1.0.0's rule for "is this write newer than the one I have?" read it as a
position in the block. The rule now never compares those numbers: within one
block the live stream's order decides, and the chain's own last write of a
block, once read back in full, always lands.

**What to do: upgrade and restart.** A normal restart is enough — you do not
need to delete anything or start from scratch. The world file the daemon
saves on disk is only ever written from the game's own state export and
snapshot service, never from the values a running daemon applied, so it
never held the stale values; on restart every value is rebuilt under the
corrected rule. (Starting from an empty `--data-dir` also works, and costs
what a first start costs — see "Minimum machine" above — but it fixes nothing
a restart does not.)

**Two new fields in `status.sync`, both optional:**

- `reconcileRepairs` — how many times the daemon's periodic re-read of the
  chain had to correct a value the live stream should already have
  delivered (for a block the stream had already moved past). On a healthy
  daemon it stays `0`. If it rises, the daemon has fixed something by itself
  — each one is also a WARN line in its log — and it is worth reporting.
  It never puts anything in `degraded`.
- `lastRepair` — the most recent such correction: `block`, `component`,
  `entity` and `at`. The key is absent until there has been one.

If you validate `status` with a closed schema, allow both.

### What changed in 1.0.0, for the things that read this daemon

1.0.0 is a correctness release first: an answer never looks complete when
it is not, and you can now ask the daemon to wait until it has seen your
own transaction. It also adds the reads for the Ether Shard loop — pending
withdrawals and an exact pool quote — and moves to the current game client.

**If you read this daemon today with 0.6.3, change these, in this order.**

1. **`feed` with no cursor now gives you the NEWEST 50 events, oldest of
   those first.** It used to give you the OLDEST 500 in its buffer — on a
   full buffer, events from long ago. If you page through the feed, pass
   the cursor every time: `feed <lastSeq>` still means "everything after
   this, oldest first", now capped at 50 unless you say `--limit <n>` (up
   to 500). To get the old behaviour exactly, ask `feed 0 --limit 500`.
   Two numbers in one request (`feed 120 50`) used to mean "since 50"
   without telling you; it is now an error — the cap is `--limit`. The
   answer says how many events matched (`eventsMatched`) and how many it
   gave you (`eventsServed`); if the second is smaller, there are more.
   `--account <index>` keeps the events that involve that account or a
   kami it owns now.
2. **`meta.asOf.observedBlock`, `observedBlockTime` and `observedAgoMs` are
   gone.** They were renamed in 0.6.1 and kept for one release. Read
   `clockSampleBlock`, `clockSampleBlockTime` and `clockSampleAgoMs`.
3. **The three chain-head fields on `status` can be missing, more often
   than before.** `headBlockNumber`, `headSampledAt` and `blockLag` now come
   from a reading taken every 10 seconds in the background, not from a
   fresh read per request. All three are left out together whenever there
   is no reading yet (the first seconds after start) or the newest one is
   more than 60 seconds old (the RPC has been failing for a minute). So:
   - if you compute lag from `headBlockNumber`, handle the field being
     ABSENT — it is not `0` and not `null`, the key is missing;
   - absence now means "no reading in the last minute", not "this request's
     read failed";
   - `blockLag` can be up to one reading old, and because it never goes
     below 0 it can read `0` while the mirror is a few blocks behind the
     true head — look at `headSampledAt` if that matters;
   - `status` no longer waits on the chain at all, so it answers instantly
     even when the RPC is slow; that is the point of the change.
4. **"Is my transaction in this answer yet?" moved.** Compare your
   receipt's block against **`meta.appliedThrough`**, which every answer now
   carries — or better, send the read with **`--at-least <yourBlock>`** and
   the daemon waits (up to 5 seconds, `--max-wait` up to 30) until it has
   applied that block, then answers; if it cannot in time it answers
   `NOT_APPLIED` and tells you how far it got. `meta.reconciledThrough` is
   still served but now means only "re-read from the chain and proven"; it
   starts lower than it used to and is not the right number for this.
5. **A kami that cannot be read completely is no longer shown as healthy.**
   Asking for one such kami (`kami`, `skills <kami>`, or the attacker of
   `node … --with-vitals`) answers `INCOMPLETE`. In a list (`node`,
   `party`, `roster`) the kami keeps its row with `incomplete: true` and no
   numbers. `meta.incompleteRows` counts them when there are any.
6. **ERC20 items carry their token.** Rows for Ether Shard (103) and Onyx
   Shard (100) in `item` and `items` gain `token: {address, scale}`. If you
   validate with a closed schema, allow it.
7. **`kami <index> --stateless` refuses flags it cannot honour.** `--stats`
   used to be ignored there without a word; it now answers
   `REQUIRES_DAEMON` (exit 5), as does `--equipment`.
8. **Two arguments that used to be ignored are now errors:** a third bare
   number on `node`, and a repeated value option.
9. **`status` has more in it** — `incompleteRows`, and in `sync`:
   `appliedThrough`, `shortReads`, `olderWritesSkipped`,
   `lastReconcileAdvanceAt`. `degraded` can now say
   `reconcile-stalled:<seconds>`.
10. **Shop prices on decaying listings can read higher than before — and
    now match what the game charges.** The game's contracts floor a
    falling-price listing at three periods of decay and charge at least 1
    per unit; the client version this daemon followed until now did not,
    so `merchant` could show a price below the one you would pay. It now
    applies the same floor, as the current game client does.
11. **`version` reads `1.0.0` and `upstreamPin` reads `ffda3963…`.**

Everything else is new and only appears when you ask for it:

- **`receipts <account>`** — the account's withdrawals that are still
  waiting to be claimed: how much, the tax already taken, when it can be
  claimed, whether it is claimable now, and where the claim would pay (the
  owner, or for a withdrawal sent to the operator, the account's operator
  as of now — the game decides at claim time). **Only waiting ones:** the
  game deletes a withdrawal when it is claimed or cancelled, so an empty
  list means nothing is waiting, not that nothing was ever withdrawn. The
  history is still `portal`.
- **`quote <fromItem> <toItem> <amount> [--exact-out]`** — what a pool swap
  pays, to the unit, fee included: sell exactly `amount`, or with
  `--exact-out` buy at least `amount` for the smallest input that does it.
  It answers `NOT_QUOTABLE` where the game would refuse the swap. Checked
  against the chain's own reserves in both directions and both modes.
- **`pool-history <itemA> <itemB> [fromTs]`** — a pool's price history, as
  the game's history service reports it.
- **`node <index> --targets <k1,k2,…>` / `--account <index>`** — read only
  the kamis you care about on a crowded node; the daemon skips the rest
  before doing any work on them. `targetsAbsent` lists the ones not there.
- **`roster --stats --full`** — every row, not the first 50.
- **`kami <index> --equipment`** — what it has equipped, slot by slot.
- **A client that hangs up stops its wait.** If you disconnect while an
  `--at-least` read is waiting, the daemon drops the wait at once. Many
  short connections cost the daemon nothing much; starting a new CLI
  process for every call is what costs (a Node start each time) — keep one
  connection open if you can.
- **Config changes in the game reach the daemon without a restart.**

### What changed in 0.6.3, for the things that read this daemon

Three things a reader of this daemon can feel, and they are all about the
daemon being AVAILABLE rather than about what it says.

**`status` no longer goes quiet every ten minutes.** Every ten minutes
this daemon refreshes the world file it keeps on disk, and writing that
file — about 230 MB — used to occupy the single thread that also answers
your questions. On a small machine that meant **20 to 32 seconds with no
answer at all**, every ten minutes; on a fast laptop, four or five
seconds. Anything polling the daemon for health saw a dead process, and
on the server it was watched by, the watchdog restarted it — in the
middle of the write, which is the one moment a restart is expensive. The
refresh now happens in a separate process, so the daemon keeps answering
throughout. If you have a monitor that tolerated those gaps, it no longer
has to.

**And it will tell you when one is happening.** `status.checkpoint` gains
`inFlight`: true while that refresh is running. It is worth having mostly
because it is now answerable — before this release, asking during a
refresh did not get you a reply to read the field from.

**A first start on a small machine no longer needs a second attempt.** A
daemon with no saved state downloads the world in pieces. On a
two-processor server, applying one piece kept the process busy long
enough that the other downloads timed out against their own clock and had
to start over, and long enough that the daemon's internal "am I stuck?"
check concluded it was — and restarted a start-up that was going fine.
First start took four and a half minutes instead of two. The apply now
hands the process back regularly while it works, reports its progress
continuously instead of once per piece, and downloads fewer pieces at
once when there are few processors to go round. None of the timeouts were
loosened; they were being told the wrong thing.

**One field reads honestly now.** `lastFullLoad` said how this daemon's
world arrived, and on a restart from saved state it reported the small
catch-up as though it were a full download — "from the snapshot service,
1.4 seconds", for something that takes a minute and a half. It now
carries `kind`, either `full` or `delta`, so the 1.4 seconds has
something to belong to.

**Two strings you should have been getting, and were not.** A bug in how
this daemon decides which text is machine-written and which is
player-written meant `status.config.stateCdnUrl` has been **removed from
every status answer since 0.6.2**, and entries in `feedsDegraded` have
been removed since 0.5.2 whenever there were any. Both were listed in
`meta.suppressed`, so the answers were honest about withholding them —
they were simply withheld for no reason. Both are back.

**A first start no longer needs to be told how much memory to use.** Until
now, starting the daemon with no configuration on a fresh machine did not
work: it loaded the world until it ran out of memory — about twenty seconds
in, two thirds of the way through — and died. Every daemon that has ever
worked was started with a memory limit set by hand, and nothing shipped
one. It now sets its own at startup, and says so in one line. On a machine
too small to finish the load it refuses to start at all, in under two
seconds, naming what it needs — rather than dying a few minutes in. If you
set the limit yourself, that is what it uses, whatever it is. There is a
new `heap` block in `status` saying which of the three happened. The one
requirement: raising its own limit needs Node 22.15 or newer; on older Node
it refuses with the single line that fixes it. See Configuration → Memory.

**`status` also serves `checkpointCount`** — how many times this process has
refreshed its saved copy of the world. It had been counting since the first
release and never telling anyone.

**If you supervise this daemon, one timing note.** Because the world-file
refresh now happens in a separate process, a stop can wait for one that
is already under way: up to 55 seconds (45 to let it finish, plus 10 more
if it had already started writing). That wait exists only to avoid
throwing away work — **it is not needed for safety.** The file is written
to a temporary name, flushed to disk, the old copy renamed aside and the
new one moved into place, in that order, so at every instant there is
either a good current file or a good previous one, and never neither. A
supervisor that kills the daemon sooner is therefore safe: launchd gives
20 seconds by default, systemd 90, and either way the worst case is one
skipped refresh, never a damaged file. If you would rather not wait, kill
sooner; nothing needs configuring.

**No query answer changes otherwise.** No field was renamed, retyped,
removed or given a new meaning, and the deprecated clock-field aliases
from 0.6.1 are still here — they go in 0.7.0 as promised.

### What changed in 0.6.2, for the things that read this daemon

One change you will notice, one you will only notice if you were
watching the daemon come up, and one you would never have noticed and
should know about anyway.

**A fresh daemon starts much faster, and you do not have to do
anything.** Until now, a daemon with no saved state fetched the whole
world down one streaming connection from the game's snapshot service.
When that connection broke — and through early September it broke
repeatedly — the daemon started over from the beginning, every time. The
game's own web client no longer works that way: the world is exported to
a file store every couple of hours, and the client downloads it in
several pieces at once. This daemon now does the same, out of the box,
with no configuration.

**If it cannot, it quietly does what it used to.** Every way this can go
wrong — the export is missing, unreadable, out of date against the live
world, or its files have expired — falls back to the old path. You can
also turn it off outright, with `--state-cdn-url none` (or `false`, or
the empty string), and then the daemon behaves exactly as 0.6.1 did.
Turning it off is a setting, not a workaround: nothing about the answers
changes either way.

**`status` now tells you which way it came up.** A new `lastFullLoad`
says whether this daemon's world came from the file store or from the
snapshot service, which export it was, which block and nonce it is
stamped at, and how long it took. It reads `null` on a daemon that
resumed from saved state, which is the normal restart — that is not a
problem, it just means no full load happened. `status.config` gains
`stateCdnUrl` when the file store is in use, and `configSources` always
says which level decided it.

**No query answer changes.** No field was renamed, retyped, removed or
given a new meaning, and the deprecated clock-field aliases from 0.6.1
are still here — they go in 0.7.0 as promised, not in a patch.

Under the hood, two bugs we had never picked up from upstream are fixed.
One made a busy snapshot service look like a broken one. The other could
silently drop the tail of a block from the saved world file, and drop it
permanently — some values are written once and never repeated, so a
missed one stays missed. Both are the snapshot path, both are described
in SPEC.md's changelog, and neither was visible from the outside, which
is precisely why they are worth naming here.

### What changed in 0.6.1, for the things that read this daemon

Two changes to what every answer tells you, and both are about a reader
knowing how fresh an answer is without having to ask twice.

**Every answer now says how far it has been verified.** `meta` carries a
new `reconciledThrough`: the block through which this mirror has genuinely
read everything from the chain and applied it. It sits beside
`blockNumber`, and the difference between them matters. `blockNumber` is
the newest block the mirror has applied *something* from — it moves on
whatever the stream happened to deliver. `reconciledThrough` moves only
over blocks that were read completely from the chain. **If you have just
sent a transaction and want to know whether this daemon can see it yet,
compare its receipt block against `reconciledThrough`.** The number
existed in 0.6.0 but only on `status`, which is a separate question asked
at a separate moment — so pairing it with a world read was comparing two
different instants. Now it rides on the answer itself. It reads `null`,
never `0`, when nothing has been verified yet.

**Three fields are renamed, because their old names misled people.**
`observedBlock`, `observedBlockTime` and `observedAgoMs` are now
`clockSampleBlock`, `clockSampleBlockTime` and `clockSampleAgoMs`. They
were never about how fresh the mirror is. They describe the daemon's
*clock*: which block's timestamp it last used to check its own sense of
time, something it redoes every five minutes on a timer. So
`clockSampleAgoMs` climbing toward 300,000 is a healthy daemon counting
down to its next check, and nothing more. Twice, readers took it for how
far behind the mirror was and made decisions on it — the second time
after we had written the explanation down in two places. The explanation
was not the problem; the word "observed" was.

**The old names still work, and only until the next release.** They carry
identical values through 0.6.1 and are removed in 0.7.0, so you have one
version to switch. If you want mirror lag, it is `status.blockLag`. If you
want verified freshness, it is `meta.reconciledThrough`.

Also in this release, and invisible from the outside: two of our own
verification gates could have reported success while checking almost
nothing, and both are fixed. Details in SPEC.md's changelog.

### What changed in 0.6.0, for the things that read this daemon

One change, and it is about staying right rather than answering more.

**The mirror no longer trusts the stream service to tell it what it
missed.** On 2026-09-06 this daemon reported six kamis as harvesting for
three and a half hours after they had stopped harvesting on chain, and a
seventh a minute later. Nothing was wrong with the chain and nothing was
wrong with the query — the mirror itself had a hole in it, and it had no
way to know. The stream server closes its connection every half minute or
so, and every time it reconnects the client asks "what did I miss?". The
service that answers is filling its own store at the same moment, so the
answer was reliably missing the newest few blocks — and the client took it,
believed it, and moved its bookmark past the blocks it had never read. Once
the bookmark moves, nothing goes back.

From 0.6.0 every recovery read goes to **the chain**, which cannot be half
finished. A recovery range is read completely or not at all; if the node
serving it is not far enough along yet, the range is written down as unread
rather than half-applied, and retried. On top of that a **reconcile pass**
re-reads everything since the last confirmed block every two minutes,
whether or not anything looked wrong — because a gap you never noticed is
the one that costs you.

You can see all of it. `status` gains a `sync` block: how many times the
stream reconnected, how many ranges were healed, how many were deferred, and
`reconciledThrough` — the block through which this mirror has genuinely read
everything. If a range stays unread for two reconcile passes, `degraded`
says `unhealed-ranges:N`, which means: **this mirror knows it is
incomplete.** That sentence did not exist before, and its absence is why the
2026-09-06 loss ran for three and a half hours before a human noticed a kami
that should not have been harvesting.

Two settings, both optional: `reconcile_interval_ms` (default 120000; set it
to 0 to switch the pass off, and `status` will say so).

### What changed in 0.5.3, for the things that read this daemon

One change, and it fixes an answer that could mislead you.

**`--eligible-only` no longer goes blank when your own kami is busy.**
Before 0.5.3 the filter asked "can this kami liquidate that one right
now", which includes whether your kami is starving or still on
cooldown. So in a fast kill loop — where your kami sits at zero health
for a few seconds after every kill — a read taken in that window came
back with an empty list and `harvestsEligible: 0`, on a node with
twenty-odd targets sitting under the threshold. That is exactly what an
emptied-out node looks like, and there was no way to tell the two
apart. From 0.5.3 the list answers one question only: **which targets
are in reach** (their projected health is below the threshold, with the
margin still positive). Whether *you* can act is answered separately
and once, by a new `blocked` field on the `attacker` block of the same
answer — `null` if your kami is ready, otherwise `ATTACKER_STARVING` or
`ATTACKER_COOLDOWN`. That field is there whenever you pass an attacker,
with or without the filter, so one read tells you both things.

Each row still carries the full verdict it always did: a served row may
say `eligible: false` with `reason: ATTACKER_STARVING`, which is the
truth about that pairing at that instant. Nothing about `eligible` or
`reason` changed. **If your kami was healthy, every answer is
byte-for-byte what 0.5.2 returned** — the two filters pick the same
rows in that case, and the gate asserts it.

### What changed in 0.5.2, for the things that read this daemon

Four changes. Two are new options you have to ask for; two change what
you get back without being asked.

**The daemon no longer pretends to be up when it is not.** If it is
still starting, every world read now fails with the code `NOT_READY`
and a message saying which phase it is in and how far along
("daemon not LIVE (SETUP 0%): mirror empty"). It used to answer
`NOT_FOUND — node 9 not in mirror`, which reads exactly like "there is
no such node" and sent callers hunting for a missing thing instead of
waiting. From now on `NOT_FOUND` only ever means "the daemon is up and
the world does not contain this". The `status` and `health` reads keep
answering at all times, as before. Underneath, a daemon that gets stuck
while starting now gives up and restarts itself after 90 seconds
instead of sitting there indefinitely, and while it is stuck the
`degraded` list says `pre-live-stall:<seconds>`.

**The health summary now covers the feed service too.** `status` has a
second list beside `degraded`, called `feedsDegraded`. The old list
covers the blockchain mirror only, on purpose — a feed outage must not
make chain answers look stale. But nine of the reads (killers, battles,
trades, auctions, market, portal, transfers, feed, chat) come from the
feed service, and a caller checking only the old list saw a healthy
daemon while the feed was flapping. Check `feedsDegraded` before
trusting any of those nine. Note that a rising reconnect count is
normal here: the server hangs up roughly every 40 seconds by design, so
the new list keys on whether the stream is live and how long it has
been silent, not on how often it reconnected.

**Every answer now says when it was computed.** There is a new `asOf`
block in the `meta` of every response: the mirror block, the moment the
projection math used, and — separately — which block the daemon's clock
correction came from, how big that correction is, and how long ago it
was taken. They are separate on purpose, because they are different
facts. This matters because the daemon's clock was measured running
about 15 seconds behind real chain time, and it can jump backwards by
several seconds when it re-syncs. Nothing about the computed values
changed in this release; you can now see the uncertainty instead of
guessing at it. Two related additions: single-kami and node-occupant
reads carry `cooldownUntil`, the raw cooldown end time from the chain,
beside the projected `cooldownSec` — compare it against a block
timestamp you trust rather than trusting the projection, and read a
zero as "unknown", never as "ready now". And each liquidation preview
carries `margin`, which is the HP threshold minus the target's
projected HP, so you can require a safety cushion instead of trusting
the `eligible` flag. The error on that projection is genuinely not
bounded and the registry says so rather than inventing a number.

**Two new options that make big answers small.** `node <index>
<attacker> --with-vitals --eligible-only` returns only the occupants
that attacker can actually liquidate. (Narrowed in 0.5.3 — it now
returns the occupants that are in REACH, and reports the attacker's own
readiness separately; see above.) It needs both the vitals flag and
an attacker (it refuses without either, since eligibility is a pairing,
not a property of the target). The whole-node count still comes back as
`harvestsTotal`, with `harvestsEligible` beside it saying how many
passed the filter, so an empty list means "none eligible" and never
"nothing here". Measured on the live world: one node went from 1.3 MB
to 15.9 KB. And `account <index> --slim` returns identity only — index,
name, both addresses, room, stamina, and a kami count — with no roster
at all. A 164-kami account was 23 KB and is now about 300 bytes, and
because slim drops the gas balance it makes no blockchain call either,
so a bulk name lookup is cheap. Without these flags, every answer is
byte-for-byte what 0.5.1 returned.

**Unknown options are now refused, not ignored — and this one affects
upgrade order.** Asking a 0.5.1 daemon for something it does not
understand over its socket got you a plausible wrong answer rather than
an error: `account 3379 --slim` came back with the whole roster and
`ok: true`, and `node ... --eligible-only` came back unfiltered and
`ok: true`. The command-line tool refused both correctly; the socket,
which is what programs actually talk to, did not. From 0.5.2 both
refuse, with the same `BAD_ARGS` message. The practical consequence:
**a client built for 0.5.2 talking to a 0.5.1 daemon receives exactly
the large payloads it asked to avoid, with no error**, so do not run a
mixed pair — deploy the lens first, then the client that uses the new
options.

One known problem, not fixed here: the `room` read lists some exits
twice, when a destination is reachable both as a neighbour and by a
special exit. Nothing it reports is wrong, but if you deduplicate by
destination, merge the gate lists or you will drop a gate. Fixing it
removes fields from an answer, which needs its own release to review
properly; it is still scheduled, and 0.5.3 did not take it up.

0.4.0 added optional payload enrichment (above): the facts a client shows
in a tooltip — what an item does, what using it requires, what a quest
pays, which room an index names — served inline in the results that name
those things, from the chain and deployed config only (DESIGN §3.12).
Off by default, and off is the 0.3.0 surface exactly.

0.3.0 added per-objective quest progress, account-relative quest state,
item-pool state, a compact roster query, and the starter vendor's
display window — under one principle: a failure must never cite state
the reader could not have read beforehand (DESIGN §3.11).

No release act has been performed: nothing is published to npm or a
container registry yet. Build and run it from this repository.

## License

kami-lens is AGPL-3.0 — see [LICENSE](LICENSE).

Copyright (C) 2026 Anatoly Zaytsev (tokedo).
