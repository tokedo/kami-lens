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

## Status

Design phase. No runnable code yet.

## License

AGPL-3.0 — see [LICENSE](LICENSE).
