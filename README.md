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

## Status

**0.6.1, pre-release.** Daemon, CLI, and library are implemented and
gate-verified against the pinned upstream commit and the live game,
with dated per-run evidence in `docs/measurements/`. The verification
suite is G0–G9 (G8 and G9 are manual and live); every run writes its
own dated record, and the record — not this paragraph — is what a
given release rests on. The contract registry is [SPEC.md](SPEC.md);
per-surface coverage — what is served, what is deferred, what is out
of scope — is [docs/coverage.md](docs/coverage.md).

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
